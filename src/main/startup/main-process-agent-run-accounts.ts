import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentHookServer } from '../agent-hooks/server'
import {
  AgentRunAccounts,
  type AgentRunAccountSettings
} from '../agent-accounts/agent-run-accounts'
import { installAgentRunAccounts } from '../agent-accounts/agent-run-accounts-installed'
import { KeptAgentConversations } from '../agent-accounts/kept-agent-conversations'
import type { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { getOrcaUserDataPath } from '../codex/codex-home-paths'
import {
  getCodexPaneAccount,
  releaseKeptCodexPanesForAccount
} from '../codex/codex-pane-account-registry'
import { getPtyIdForPaneKey } from '../ipc/pty/pane/key-state'

const ACCOUNT_LIST_SETTINGS = ['claudeManagedAccounts', 'codexManagedAccounts'] as const

type AccountIds = { claude: Set<string>; codex: Set<string> }

function accountIds(settings: AgentRunAccountSettings): AccountIds {
  return {
    claude: new Set(settings.claudeManagedAccounts.map((account) => account.id)),
    codex: new Set(settings.codexManagedAccounts.map((account) => account.id))
  }
}

/** A removed account releases what was kept on it: kept agents follow the selection again. */
function releaseRemovedAccounts(
  before: AccountIds,
  after: AccountIds,
  kept: KeptAgentConversations
): void {
  for (const id of before.claude) {
    if (!after.claude.has(id)) {
      kept.releaseAccount('claude', id)
    }
  }
  for (const id of before.codex) {
    if (!after.codex.has(id)) {
      kept.releaseAccount('codex', id)
      releaseKeptCodexPanesForAccount(id)
    }
  }
}

/** Creates the run-account producer and feeds it status rows, statusline folders and account changes. */
export function startAgentRunAccounts(args: {
  server: AgentHookServer
  getSettings: () => AgentRunAccountSettings
  onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => void
  claudeRouter: ClaudeProfileRouter | null
  keptFilePath?: string
}): AgentRunAccounts {
  const { server, claudeRouter } = args
  const kept = new KeptAgentConversations({
    filePath: args.keptFilePath ?? join(getOrcaUserDataPath(), 'agent-kept-conversations.json')
  })
  const producer = new AgentRunAccounts({
    republish: (paneKey, runAccount) => server.republishRunAccount(paneKey, runAccount),
    getRow: (paneKey) => server.getRunAccountRow(paneKey),
    listRows: () =>
      server.getStatusSnapshot().map((row) => ({
        paneKey: row.paneKey,
        connectionId: row.connectionId,
        providerSession: row.providerSession,
        runAccount: row.runAccount,
        structuredHost: row.structuredHost,
        payload: { agentType: row.agentType }
      })),
    getSettings: args.getSettings,
    getPtyIdForPaneKey,
    readCodexRecord: getCodexPaneAccount,
    claudeFolders: claudeRouter
      ? {
          accountHome: (accountId) => claudeRouter.accountHome(accountId),
          systemDefaultHome: () => claudeRouter.systemDefaultHome(),
          coveredBySystemDefault: (accountId) => claudeRouter.coveredBySystemDefault(accountId)
        }
      : null,
    kept
  })
  installAgentRunAccounts({ producer, kept })
  server.subscribeEnrichedStatus((row) => {
    try {
      producer.noteStatus(row)
    } catch (error) {
      console.warn('[agent-run-accounts] Could not publish an agent account:', error)
    }
  })
  server.subscribeClaudeStatusLinePanes((event) => producer.noteClaudeStatusLine(event))
  let known = accountIds(args.getSettings())
  args.onSettingsChanged((updates) => {
    if (!ACCOUNT_LIST_SETTINGS.some((key) => key in updates)) {
      return
    }
    const next = accountIds(args.getSettings())
    releaseRemovedAccounts(known, next, kept)
    known = next
    producer.refreshAll()
  })
  void kept.pruneUnreachable().catch((error: unknown) => {
    console.warn('[kept-conversations] Could not prune kept conversations:', error)
  })
  return producer
}
