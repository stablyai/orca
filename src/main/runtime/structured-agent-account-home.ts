import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'

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
    | ((input: {
        workspacePath: string
        launchEnv: NodeJS.ProcessEnv
      }) => string | null | Promise<string | null>)
    | null
  /** Empty for a record-less read; only launch preparation consumes it. */
  workspacePath: string
}

export async function resolveStructuredCodexAccountHomePath(
  deps: StructuredCodexAccountHomeDeps
): Promise<string> {
  // A create has no process yet, so the current selection is what it must follow.
  const resolvedHome = await deps.resolveLaunchHome?.({
    workspacePath: deps.workspacePath,
    launchEnv: deps.launchEnv
  })
  const configuredHome = deps.launchEnv.CODEX_HOME
  return (
    resolvedHome?.trim() ||
    (deps.resolveLaunchHome ? getSystemCodexHomePath() : configuredHome?.trim()) ||
    getSystemCodexHomePath()
  )
}
