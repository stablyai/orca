import { resolve } from 'node:path'
import { getSystemCodexHomePath } from './codex-home-paths'

/** True when the user points Codex outside its standard native home. */
export function hasCustomCodexHomeOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  const codexHome = env.CODEX_HOME?.trim()
  const orcaCodexHome = env.ORCA_CODEX_HOME?.trim()
  const normalizedCodexHome = codexHome ? normalizePathForComparison(codexHome) : undefined
  const normalizedOrcaCodexHome = orcaCodexHome
    ? normalizePathForComparison(orcaCodexHome)
    : undefined
  // Why: phase 1 owns only ~/.codex and can clean that path on downgrade. A
  // custom home needs cross-home ownership tracking before Orca may mutate it.
  return Boolean(
    normalizedCodexHome &&
    normalizedCodexHome !== normalizedOrcaCodexHome &&
    normalizedCodexHome !== normalizePathForComparison(getSystemCodexHomePath())
  )
}

function normalizePathForComparison(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
