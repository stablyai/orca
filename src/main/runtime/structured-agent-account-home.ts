import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { normalizeCodexRuntimeSelection } from '../codex-accounts/runtime-selection'
import { resolveOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The one resolver for "which account home would a structured launch pin right
// now". The create path fills `record.accountHome` with it, and the model
// catalog's record-less reads key their fingerprint with it — a second copy of
// this selection is how a picker ends up showing another account's models.

export type StructuredClaudeAccountHomeDeps = {
  launchEnv: NodeJS.ProcessEnv
  wslDistro: string | null
  getClaudeConfigDirectory: (
    target: { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string }
  ) => string | null | undefined
}

export function resolveStructuredClaudeAccountHomePath(
  deps: StructuredClaudeAccountHomeDeps
): string {
  // Why only an account: System default keeps the launch-env and configured homes below.
  const accountHome = deps.wslDistro ? null : getClaudeProfileRouter()?.routedHome()
  if (accountHome) {
    return accountHome
  }
  return (
    deps.launchEnv.CLAUDE_CONFIG_DIR?.trim() ||
    deps
      .getClaudeConfigDirectory(
        deps.wslDistro ? { runtime: 'wsl', wslDistro: deps.wslDistro } : { runtime: 'host' }
      )
      ?.trim() ||
    join(homedir(), '.claude')
  )
}

export type StructuredCodexAccountHomeDeps = {
  launchEnv: NodeJS.ProcessEnv
  /**
   * The home a host launch would pin: launch preparation on the create path,
   * the read-only sibling for record-less reads (a read must not sync homes or
   * clear selections). Null falls back to env/system default. Both share the
   * null → system-home mapping below, so the two paths cannot drift.
   */
  resolveLaunchHome:
    | ((input: { launchEnv: NodeJS.ProcessEnv }) => string | null | Promise<string | null>)
    | null
}

export async function resolveStructuredCodexAccountHomePath(
  deps: StructuredCodexAccountHomeDeps
): Promise<string> {
  // A create has no process yet, so the current selection is what it must follow.
  const resolvedHome = await deps.resolveLaunchHome?.({ launchEnv: deps.launchEnv })
  const configuredHome = deps.launchEnv.CODEX_HOME
  return (
    resolvedHome?.trim() ||
    (deps.resolveLaunchHome ? getSystemCodexHomePath() : configuredHome?.trim()) ||
    getSystemCodexHomePath()
  )
}

export function resolveStructuredCodexAccountKind(
  home: string,
  settings: Pick<
    GlobalSettings,
    'codexManagedAccounts' | 'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'
  >
): AgentSessionAccountKind | undefined {
  const same = (other: string): boolean =>
    normalizeRuntimePathForComparison(home) === normalizeRuntimePathForComparison(other)
  if (
    (settings.codexManagedAccounts ?? []).some(
      (account) => account.managedHomeRuntime !== 'wsl' && same(account.managedHomePath)
    )
  ) {
    return 'managed'
  }
  if (same(getSystemCodexHomePath())) {
    return 'system'
  }
  if (same(resolveOrcaManagedCodexHomePath())) {
    return normalizeCodexRuntimeSelection(settings).host ? 'managed' : 'system'
  }
  return undefined
}

/** An agent whose config directory is one environment variable with a default under the user's
 *  home: the launch's own value, then this runtime's, then the default. */
export function resolveStructuredEnvAccountHomePath(input: {
  launchEnv: NodeJS.ProcessEnv
  variable: string
  defaultPath: (homePath: string) => string
  processEnv?: NodeJS.ProcessEnv
  homePath?: string
}): string {
  return resolveAbsoluteDirOverride(
    input.launchEnv[input.variable] ?? (input.processEnv ?? process.env)[input.variable],
    input.defaultPath(input.homePath ?? homedir())
  )
}
