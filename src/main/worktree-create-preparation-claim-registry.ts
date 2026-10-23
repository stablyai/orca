// Creates that hold a prepared checkout, and the preparations deferred until each one releases it.
import { preparationEntryKey, preparationPathKey } from './worktree-create-preparation-claim'
import type { PreparationEntry, StartPreparationArgs } from './worktree-create-preparation-pool'

export type DeferredPreparation = {
  args: StartPreparationArgs
  kind: 'explicit' | 'automatic'
}

export type PreparationClaim = {
  entry: PreparationEntry
  requestedKey: string
  pendingPreparations: Map<string, DeferredPreparation>
}

const claims = new Set<PreparationClaim>()

export function registerClaim(entry: PreparationEntry, requestedKey: string): PreparationClaim {
  const claim = { entry, requestedKey, pendingPreparations: new Map<string, DeferredPreparation>() }
  claims.add(claim)
  return claim
}

export function hasClaims(): boolean {
  return claims.size > 0
}

export function isClaimed(entry: PreparationEntry): boolean {
  return [...claims].some((claim) => claim.entry === entry)
}

function matchingClaim(args: StartPreparationArgs): PreparationClaim | undefined {
  const key = preparationEntryKey(
    preparationPathKey(args.repoPath),
    preparationPathKey(args.workspaceRoot),
    args.canonicalBase,
    args.options.wslDistro ?? ''
  )
  return [...claims]
    .toReversed()
    .find((claim) => claim.entry.key === key || claim.requestedKey === key)
}

/** Preserve one request per canonical key, with explicit prefetch taking precedence. */
export function deferPreparationForClaim(
  args: StartPreparationArgs,
  kind: DeferredPreparation['kind']
): boolean {
  const matching = matchingClaim(args)
  if (!matching) {
    return false
  }
  const key = preparationEntryKey(
    preparationPathKey(args.repoPath),
    preparationPathKey(args.workspaceRoot),
    args.canonicalBase,
    args.options.wslDistro ?? ''
  )
  if (kind === 'explicit' || !matching.pendingPreparations.has(key)) {
    matching.pendingPreparations.set(key, { args, kind })
  }
  return true
}

/** A second release is inert, including after a test reset. */
export function releasePreparationClaim(claim: PreparationClaim): {
  released: boolean
  pendingPreparations: DeferredPreparation[]
} {
  if (!claims.delete(claim)) {
    return { released: false, pendingPreparations: [] }
  }
  return { released: true, pendingPreparations: [...claim.pendingPreparations.values()] }
}

export function resetClaimsForTests(): void {
  claims.clear()
}
