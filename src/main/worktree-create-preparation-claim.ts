import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { worktreeBaseRefFamily } from '../shared/worktree/base-ref'
import type { PreparedCheckoutMissReason } from '../shared/worktree/create-types'

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
  /** Resolved ref spelling, so main and refs/heads/main compare equal. */
  canonicalBase: string
  createdAt: number
}

export type PreparationRequest = {
  repoPathKey: string
  workspaceRootKey: string
  wslDistro: string
  baseBranch: string
  /** Null skips the ref probe when the raw base already matches. */
  canonicalBase: string | null
}

export function preparationPathKey(path: string): string {
  if (isWindowsAbsolutePathLike(path)) {
    return win32.normalize(path).toLowerCase()
  }
  return posix.normalize(path)
}

/** Canonical refs let prefetch and create share an entry despite different spellings. */
export function preparationEntryKey(
  repoPathKey: string,
  workspaceRootKey: string,
  canonicalBase: string,
  wslDistro: string
): string {
  return `${repoPathKey}\0${workspaceRootKey}\0${canonicalBase}\0${wslDistro}`
}

export type PreparationSelection<T> =
  /** Reuse this canonical base when re-arming to avoid a second ref probe. */
  | { kind: 'exact'; candidate: T; canonicalBase: string }
  | { kind: 'retarget'; candidate: T; canonicalBase: string }
  /** Resolve the canonical base before deciding whether the armed entry matches. */
  | { kind: 'needs-canonical-base' }
  | { kind: 'miss'; reason: PreparationSelectionMissReason }

/** Retarget only within one branch family; unrelated history can cost a full checkout. */
export function selectPreparationForCreate<T extends PreparationCandidate>(
  candidates: readonly T[],
  request: PreparationRequest
): PreparationSelection<T> {
  if (candidates.length === 0) {
    return { kind: 'miss', reason: 'none_armed' }
  }
  const sameRepo = candidates.filter((candidate) => candidate.repoPathKey === request.repoPathKey)
  if (sameRepo.length === 0) {
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
