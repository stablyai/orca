import type { GlobalSettings } from '../../shared/global-settings-types'
import { hasCustomCodexHomeOverrideForLaunch } from '../codex/codex-real-home-path'
import { keptAccountRefusals } from './kept-account-refusals'
import { getKeptAgentConversations } from './agent-run-accounts-installed'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'

export type KeptCodexHomeRuntime = {
  resolveHostAccountCodexHomePathForKeptResume: (accountId: string) => string
}

export function codexAccountLabel(
  settings: Pick<GlobalSettings, 'codexManagedAccounts'> | undefined,
  accountId: string | null
): string {
  if (accountId === null) {
    return 'System default'
  }
  return (
    settings?.codexManagedAccounts.find((account) => account.id === accountId)?.email ??
    'a removed account'
  )
}

/** The CODEX_HOME a kept conversation resumes in; refuses rather than run elsewhere or copy credentials. */
export function resolveKeptCodexHome(args: {
  accountId: string | null
  runtimeHome: KeptCodexHomeRuntime
  systemCodexHomePath: string
  launchEnv?: NodeJS.ProcessEnv
}): string {
  if (args.accountId !== null) {
    return args.runtimeHome.resolveHostAccountCodexHomePathForKeptResume(args.accountId)
  }
  if (hasCustomCodexHomeOverrideForLaunch(args.launchEnv)) {
    throw keptAccountRefusals.codexSystemDefaultWithCustomHome()
  }
  return args.systemCodexHomePath
}

/** Session History's view of a kept Codex conversation: its home, or undefined when not kept. */
export function resolveKeptCodexHomeForSession(
  sessionId: string,
  runtimeHome: KeptCodexHomeRuntime | null | undefined
): string | undefined {
  const kept = getKeptAgentConversations()
  if (!kept) {
    return undefined
  }
  const entry = kept.get('codex', sessionId)
  if (entry === 'unavailable') {
    throw keptAccountRefusals.indexUnavailable(kept.filePath)
  }
  if (!entry) {
    return undefined
  }
  if (entry.lane !== 'host' || !runtimeHome) {
    throw keptAccountRefusals.laneMismatch()
  }
  return resolveKeptCodexHome({
    accountId: entry.accountId,
    runtimeHome,
    systemCodexHomePath: getSystemCodexHomePath()
  })
}
