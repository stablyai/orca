import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export type CodexResumeHomeSnapshot = {
  trustedCodexHomes: string[]
  selectedAccountCodexHome: string | null
}

export type CodexResumeHomeSnapshotSource = {
  getHostCodexHomePathsForSessionDiscovery: () => readonly string[]
  resolveSelectedHostAccountCodexHomePathForResume: () => string | null
}

function uniqueTrustedHomes(homes: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const home of homes) {
    const comparison = normalizeRuntimePathForComparison(home)
    if (seen.has(comparison)) {
      continue
    }
    seen.add(comparison)
    unique.push(home)
  }
  return unique
}

/**
 * Why: discovery silently omits a home whose ownership read is `indeterminate`
 * (transient EBUSY/EPERM). Selection, microseconds later, may succeed for that
 * same home. The legacy rescan iterates only the discovery list, so a competing
 * alias in another account would win (STA-4919). Append a missed selected home
 * only after this read verified it — never because verification was skipped.
 */
export function snapshotCodexResumeHomes(args: {
  systemHomePath: string
  runtimeHome: CodexResumeHomeSnapshotSource
}): CodexResumeHomeSnapshot {
  const discoveredHomes = args.runtimeHome.getHostCodexHomePathsForSessionDiscovery()
  const selectedAccountCodexHome =
    args.runtimeHome.resolveSelectedHostAccountCodexHomePathForResume()
  return {
    trustedCodexHomes: uniqueTrustedHomes([
      args.systemHomePath,
      ...discoveredHomes,
      ...(selectedAccountCodexHome ? [selectedAccountCodexHome] : [])
    ]),
    selectedAccountCodexHome
  }
}
