import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { worktreeBaseRefFamily } from '../shared/worktree/base-ref'
import type { PreparedCheckoutMissReason } from '../shared/worktree/create-types'

/** The subset of miss reasons this selection can produce; the rest are decided by the caller
 *  (sparse/existing-branch skips) or by the finalize step. */
export type PreparationSelectionMissReason = Extract<
  PreparedCheckoutMissReason,
  | 'none_armed'
  | 'repo_mismatch'
  | 'base_mismatch'
  | 'workspace_root_mismatch'
  | 'wsl_distro_mismatch'
>

export type PreparationCandidate = {
  repoPathKey: string
  workspaceRootKey: string
  wslDistro: string
  /** The base exactly as the prefetch handler armed it. */
  baseBranch: string
  /** That base after `resolveWorktreeAddBaseRef`, so `main` and `refs/heads/main` compare equal. */
  canonicalBase: string
  createdAt: number
}

export type PreparationRequest = {
  repoPathKey: string
  workspaceRootKey: string
  wslDistro: string
  baseBranch: string
  /** `null` until the caller has paid the ref probe. A raw-base match resolves without it, so the
   *  common hit spawns no git at all. */
  canonicalBase: string | null
}

/** Case-folded on Windows, so the arming and claiming sides key on the same path. */
export function preparationPathKey(path: string): string {
  if (isWindowsAbsolutePathLike(path)) {
    return win32.normalize(path).toLowerCase()
  }
  return posix.normalize(path)
}

/** Keyed on the canonical base so the prefetch and the create agree when they spell the same ref
 *  differently; a genuinely different ref still gets its own entry. */
export function preparationEntryKey(
  repoPathKey: string,
  workspaceRootKey: string,
  canonicalBase: string,
  wslDistro: string
): string {
  return `${repoPathKey}\0${workspaceRootKey}\0${canonicalBase}\0${wslDistro}`
}

export type PreparationSelection<T> =
  /** `canonicalBase` is echoed back so the caller can re-arm on the create's own base without
   *  paying the ref probe a second time. */
  | { kind: 'exact'; candidate: T; canonicalBase: string }
  | { kind: 'retarget'; candidate: T; canonicalBase: string }
  /** Something is armed for this repo but not under this raw base; only a resolved canonical base
   *  can decide between a hit and a miss. */
  | { kind: 'needs-canonical-base' }
  | { kind: 'miss'; reason: PreparationSelectionMissReason }

/**
 * Picks the armed preparation a create may claim.
 *
 * The two sides of the pool disagree in practice — the prefetch arms `origin/main` while the
 * create resolves `main`, or vice versa — and an exact-string key turns every such disagreement
 * into a silent cold create. Canonicalizing catches the spelling differences; the base-family
 * retarget catches the local-vs-remote-tracking ones, where finalize's existing drift reset lands
 * the checkout on the requested commit for far less than a cold add plus a full materialize.
 *
 * The bound matters: refs outside the same branch family are rejected, because a retarget across
 * unrelated history degenerates into a full checkout and wins nothing.
 *
 * Synchronous on purpose: the caller claims the returned entry in the same run, so two concurrent
 * creates cannot both walk away with the same prepared checkout.
 */
export function selectPreparationForCreate<T extends PreparationCandidate>(
  candidates: readonly T[],
  request: PreparationRequest
): PreparationSelection<T> {
  if (candidates.length === 0) {
    return { kind: 'miss', reason: 'none_armed' }
  }
  const sameRepo = candidates.filter((candidate) => candidate.repoPathKey === request.repoPathKey)
  if (sameRepo.length === 0) {
    // Separate from `none_armed`: this is what a size-cap eviction looks like from the create side.
    return { kind: 'miss', reason: 'repo_mismatch' }
  }
  // Distro before root: the distro decides which filesystem the root is even on.
  const sameHost = sameRepo.filter((candidate) => candidate.wslDistro === request.wslDistro)
  if (sameHost.length === 0) {
    return { kind: 'miss', reason: 'wsl_distro_mismatch' }
  }
  const sameRoot = sameHost.filter(
    (candidate) => candidate.workspaceRootKey === request.workspaceRootKey
  )
  if (sameRoot.length === 0) {
    return { kind: 'miss', reason: 'workspace_root_mismatch' }
  }

  const { canonicalBase } = request
  if (canonicalBase === null) {
    const rawMatch = sameRoot.find((candidate) => candidate.baseBranch === request.baseBranch)
    // Same spelling, so the armed entry already holds this request's canonical form.
    return rawMatch
      ? { kind: 'exact', candidate: rawMatch, canonicalBase: rawMatch.canonicalBase }
      : { kind: 'needs-canonical-base' }
  }

  const canonicalMatch = sameRoot.find((candidate) => candidate.canonicalBase === canonicalBase)
  if (canonicalMatch) {
    return { kind: 'exact', candidate: canonicalMatch, canonicalBase }
  }

  const family = worktreeBaseRefFamily(canonicalBase)
  if (family) {
    const retarget = sameRoot
      .filter((candidate) => worktreeBaseRefFamily(candidate.canonicalBase) === family)
      .sort((left, right) => right.createdAt - left.createdAt)[0]
    if (retarget) {
      return { kind: 'retarget', candidate: retarget, canonicalBase }
    }
  }
  return { kind: 'miss', reason: 'base_mismatch' }
}
