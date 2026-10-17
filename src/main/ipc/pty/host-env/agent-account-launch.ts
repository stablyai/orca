import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session-resume'
import { getCodexSelectionLaneKey } from '../../../../shared/codex-selection-lane'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  resolveAgentLaunchAccount,
  type AgentLaunchAccount
} from '../../../agent-accounts/agent-launch-account'
import {
  getKeptAgentConversations,
  noteAgentPaneLaunch
} from '../../../agent-accounts/agent-run-accounts-installed'
import type { PaneLaunchFact } from '../../../agent-accounts/agent-run-accounts'
import { withClaudeProfileTerminalEnv } from '../../../claude-accounts/claude-profile-installed-router'
import {
  prepareInstalledClaudeLaunchForAccount,
  withClaudeKeptAccountTerminalEnv
} from '../../../claude-accounts/claude-profile-account-route'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import type { PrepareClaudeAuth } from './types'

export type SpawnAccountLaunch = Exclude<AgentLaunchAccount, { kind: 'refuse' }>

/** The kept account a spawn must run on, or follow; throws the refusal before anything starts. */
export function resolveSpawnAccountLaunch(args: {
  connectionId: string | null | undefined
  launchAgent: TuiAgent | undefined
  resumeProviderSession: AgentProviderSessionMetadata | undefined
  target: CodexAccountSelectionTarget
  settings: Pick<GlobalSettings, 'claudeManagedAccounts' | 'codexManagedAccounts'> | undefined
}): SpawnAccountLaunch {
  const account = resolveAgentLaunchAccount({
    ...args,
    lane: getCodexSelectionLaneKey(args.target),
    kept: getKeptAgentConversations()
  })
  if (account.kind === 'refuse') {
    throw account.error
  }
  return account
}

function keptClaudeAccount(account: SpawnAccountLaunch): { accountId: string | null } | null {
  return account.kind === 'bound' && account.provider === 'claude'
    ? { accountId: account.accountId }
    : null
}

/** A kept Claude pane names its account's own pointer; everything else is unchanged. */
export function withSpawnClaudeTerminalEnv<Env extends Record<string, string> | undefined>(
  env: Env,
  account: SpawnAccountLaunch,
  target: CodexAccountSelectionTarget
): Env | Record<string, string> {
  const kept = keptClaudeAccount(account)
  return kept
    ? withClaudeKeptAccountTerminalEnv(env, kept.accountId)
    : withClaudeProfileTerminalEnv(env, target)
}

/** Null exactly when the selection path would not prepare auth, so a follow spawn awaits as before. */
export function prepareSpawnClaudeAuth(
  account: SpawnAccountLaunch,
  target: CodexAccountSelectionTarget,
  prepareClaudeAuth: PrepareClaudeAuth | undefined
): Promise<ClaudeRuntimeAuthPreparation> | null {
  const kept = keptClaudeAccount(account)
  if (kept) {
    return prepareInstalledClaudeLaunchForAccount(kept.accountId)
  }
  return prepareClaudeAuth ? prepareClaudeAuth(target) : null
}

export function codexKeptAccountArg(
  account: SpawnAccountLaunch | undefined
): { keptAccount: { accountId: string | null } } | Record<string, never> {
  return account?.kind === 'bound' && account.provider === 'codex'
    ? { keptAccount: { accountId: account.accountId } }
    : {}
}

/** What the run-account producer needs to know about a kept start. */
export function keptLaunchFact(
  account: SpawnAccountLaunch | undefined,
  resumeProviderSession: AgentProviderSessionMetadata | undefined
): Pick<PaneLaunchFact, 'claudeShellAccount' | 'resumedSessionId'> {
  if (account?.kind !== 'bound') {
    return {}
  }
  const resumedSessionId = normalizeAgentProviderSession(resumeProviderSession)?.id
  return {
    ...(account.provider === 'claude'
      ? { claudeShellAccount: { accountId: account.accountId } }
      : {}),
    ...(resumedSessionId ? { resumedSessionId } : {})
  }
}

/** Both spawn-commit paths: tells the run-account producer what this pane now runs. */
export function noteSpawnAccountLaunch(args: {
  paneKey: string | null | undefined
  target: CodexAccountSelectionTarget
  isReattach: boolean | undefined
  account: SpawnAccountLaunch
  resumeProviderSession: AgentProviderSessionMetadata | undefined
}): void {
  if (!args.paneKey) {
    return
  }
  noteAgentPaneLaunch({
    paneKey: args.paneKey,
    lane: getCodexSelectionLaneKey(args.target),
    fresh: args.isReattach !== true,
    ...(args.isReattach ? {} : keptLaunchFact(args.account, args.resumeProviderSession))
  })
}
