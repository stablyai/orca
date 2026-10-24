import { ProviderCleanupBudget } from '../provider-process/provider-process-exit-deadline'
import {
  discoverProviderLaunches,
  type ProviderResourceResult
} from '../provider-process/provider-process-inventory'
import { verifyRecoveredProviderResources } from '../provider-process/provider-process-ledger'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

// Serialize Orca-owned spawns per home to prevent refresh-token rotation races; terminals are exempt.

const retainedWriters = new Map<
  string,
  Set<(budget: ProviderCleanupBudget) => Promise<ProviderResourceResult>>
>()

export class CodexHomeProcessError extends Error {
  constructor(result: 'live' | 'unknown') {
    super(
      result === 'live'
        ? 'Codex is still using this account home. Try again after its previous command stops.'
        : 'Orca could not verify previous Codex processes. Try again.'
    )
  }
}

export function retainCodexHomeWriter(
  key: string,
  verify: (budget: ProviderCleanupBudget) => Promise<ProviderResourceResult>
): void {
  let writers = retainedWriters.get(key)
  if (!writers) {
    writers = new Set()
    retainedWriters.set(key, writers)
  }
  writers.add(verify)
}

async function verifyCodexHomeWriters(key: string): Promise<void> {
  const discovered = await discoverProviderLaunches(new ProviderCleanupBudget(Date.now() + 2_000))
  if (!discovered) {
    throw new CodexHomeProcessError('unknown')
  }
  const budget = new ProviderCleanupBudget()
  const writers = retainedWriters.get(key) ?? new Set()
  const results: ProviderResourceResult[] = []
  for (const verify of writers) {
    const result = budget.active ? await budget.wait(verify(budget), 'unknown') : 'unknown'
    results.push(result)
    if (result === 'released') {
      writers.delete(verify)
    }
  }
  results.push(await verifyRecoveredProviderResources(key, budget))
  if (results.includes('unknown')) {
    throw new CodexHomeProcessError('unknown')
  }
  if (results.includes('live')) {
    throw new CodexHomeProcessError('live')
  }
  retainedWriters.delete(key)
}

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
  const run = prior.then(async () => {
    await verifyCodexHomeWriters(lockKey)
    return fn()
  })
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
