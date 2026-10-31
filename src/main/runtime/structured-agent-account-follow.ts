// The execution host's half of a chat following the account picker: which home is selected, and
// carrying a conversation into it. Only Claude and Codex chats follow; other agents stay pinned.

import {
  agentSessionAccountHomesEqual,
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { activeProviderContext } from '../../shared/agent-session-provider-context'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { carryClaudeConversationToAccountHome } from '../claude/claude-chat-account-move'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { normalizeClaudeRuntimeSelection } from '../claude-accounts/runtime-selection'
import { normalizeCodexRuntimeSelection } from '../codex-accounts/runtime-selection'
import { carryCodexThreadToAccountHome } from '../codex/codex-chat-account-move'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import type {
  StructuredAgentSessionAccountFollow,
  StructuredAgentSessionAccountMove
} from '../native-chat/agent-session-wire/structured-agent-session-account-follow'

type FollowingAgent = 'claude' | 'codex'

export type StructuredAgentAccountFollowDeps = {
  /** False where another machine decides this host's accounts; its chats then never move here. */
  ownsAccounts: () => boolean
  /** The home a chat would pin if created now; `launch` also prepares it, as create does. */
  resolveSelectedHome: (
    record: AgentSessionRecord,
    purpose: 'launch' | 'read'
  ) => Promise<AgentSessionAccountHome>
  getSettings: () => Partial<
    Pick<
      GlobalSettings,
      | 'codexManagedAccounts'
      | 'activeCodexManagedAccountId'
      | 'activeCodexManagedAccountIdsByRuntime'
      | 'claudeManagedAccounts'
      | 'activeClaudeManagedAccountId'
      | 'activeClaudeManagedAccountIdsByRuntime'
    >
  >
  carryCodex?: typeof carryCodexThreadToAccountHome
  carryClaude?: typeof carryClaudeConversationToAccountHome
}

function followingAgent(
  record: AgentSessionRecord,
  deps: Pick<StructuredAgentAccountFollowDeps, 'ownsAccounts'>
): FollowingAgent | null {
  if (!deps.ownsAccounts()) {
    return null
  }
  return record.provider === 'claude' || record.provider === 'codex' ? record.provider : null
}

/** The selected account's email, as the status bar names it; absent is System default. */
function selectedAccountEmail(
  agent: FollowingAgent,
  settings: ReturnType<StructuredAgentAccountFollowDeps['getSettings']>
): string | undefined {
  if (agent === 'codex') {
    const id = normalizeCodexRuntimeSelection(settings).host
    return settings.codexManagedAccounts?.find((account) => account.id === id)?.email
  }
  const id = normalizeClaudeRuntimeSelection(settings).host
  return settings.claudeManagedAccounts?.find((account) => account.id === id)?.email
}

export function createStructuredAgentAccountFollow(
  deps: StructuredAgentAccountFollowDeps
): StructuredAgentSessionAccountFollow {
  const carryCodex = deps.carryCodex ?? carryCodexThreadToAccountHome
  const carryClaude = deps.carryClaude ?? carryClaudeConversationToAccountHome
  return {
    selectedHome: async (record) =>
      followingAgent(record, deps) ? deps.resolveSelectedHome(record, 'read') : null,
    move: async (record): Promise<StructuredAgentSessionAccountMove | null> => {
      const agent = followingAgent(record, deps)
      const source = record.accountHome
      if (!agent || !isLegacyAgentSessionAccountHome(source)) {
        return null
      }
      const target = await deps.resolveSelectedHome(record, 'launch')
      // Older Claude chats launched on the picker's account whatever their record said: seed quietly.
      const quiet = agent === 'claude' && record.accountHomeConfirmed !== true
      if (
        !isLegacyAgentSessionAccountHome(target) ||
        (!quiet && agentSessionAccountHomesEqual(source, target))
      ) {
        return null
      }
      const account = selectedAccountEmail(agent, deps.getSettings())
      const moved: StructuredAgentSessionAccountMove = {
        accountHome: target,
        ...(account === undefined ? {} : { account }),
        ...(quiet ? { quiet } : {})
      }
      const head = activeProviderContext(record).head?.handle
      // No conversation yet: nothing to carry.
      if (!head) {
        return moved
      }
      const router = agent === 'claude' ? getClaudeProfileRouter() : undefined
      const carried =
        agent === 'codex'
          ? await carryCodex({
              threadId: head.nativeId,
              sourceHome: source.path,
              targetHome: target.path,
              systemCodexHomePath: getSystemCodexHomePath()
            })
          : await carryClaude({
              sessionId: head.nativeId,
              // Older chats followed the router without repinning, so any account may hold it.
              sourceHomes: [
                source.path,
                ...(router ? [...router.accountHomes(), router.systemDefaultHome()] : [])
              ],
              targetHome: target.path
            })
      return carried ? moved : null
    }
  }
}
