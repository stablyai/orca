import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

// Serialize Orca-owned spawns per home to prevent refresh-token rotation races; terminals are exempt.
const lockTails = new Map<string, Promise<unknown>>()

export function resolveCodexHomeProcessLockKey(codexHomePath?: string | null): string {
  const home = codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  return normalizeRuntimePathForComparison(home)
}

export function resolveCodexHomeProcessLockKeyForSpawnEnv(
  env: NodeJS.ProcessEnv | undefined,
  wslDistro?: string | null,
  commandEnv?: Record<string, string>
): string {
  if (wslDistro) {
    // Match buildWslLauncherEnv: only explicit overrides reach WSL; otherwise use its default home.
    const codexHome =
      commandEnv?.CODEX_HOME ??
      (env?.CODEX_HOME !== process.env.CODEX_HOME ? (env?.CODEX_HOME ?? null) : null)
    // Normalize Linux homes like probes' UNC paths; the sentinel serializes unknown distro defaults.
    return normalizeRuntimePathForComparison(
      `//wsl$/${wslDistro}${codexHome ?? '/.orca-default-codex-home'}`
    )
  }
  // Explicit child envs can strip CODEX_HOME; do not restore it from the host environment.
  const codexHome = env === undefined ? process.env.CODEX_HOME : env.CODEX_HOME
  return normalizeRuntimePathForComparison(codexHome ?? join(homedir(), '.codex'))
}

export function withCodexHomeProcessLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prior = lockTails.get(lockKey) ?? Promise.resolve()
  const run = prior.then(fn)
  // Failed runs must not block later entrants.
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  lockTails.set(lockKey, tail)
  void tail.then(() => {
    if (lockTails.get(lockKey) === tail) {
      lockTails.delete(lockKey)
    }
  })
  return run
}
