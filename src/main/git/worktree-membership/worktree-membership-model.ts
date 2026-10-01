import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import type { AdminStatSignature } from './admin-stat-signature'
import type { RepoConfigFacts } from './repo-admin-layout'
import type { DerivedFileRow } from './worktree-membership-file-rows'
import type { UnplacedRepo } from './worktree-membership-not-repository'
import type { PromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'

// A read may reuse a derivation (finished or in flight) only if it started at the model's current
// generation and less than this long ago. Why under the watcher's 250 ms trailing debounce: every
// watcher-driven read starts at least that long after the change, so it can never reuse a
// derivation that began before the change, whatever path spelling the watcher saw.
export const MEMBERSHIP_REUSE_WINDOW_MS = 200
// Covers a same-granule rewrite on a coarse-mtime disk (1 s HFS+, 2 s FAT) that no stat caught.
export const MEMBERSHIP_FULL_DERIVE_FLOOR_MS = 5 * 60_000
export const MEMBERSHIP_IDLE_DROP_MS = 30 * 60_000

export type DerivedRowMemo = { derived: DerivedFileRow; signature: AdminStatSignature }

/** Everything the file rules derived, replaced as a unit when a derivation commits. */
export type FileDerivationState = {
  facts: RepoConfigFacts
  configStamp: string | null
  packedStamp: string | null
  /** Only the refs rows looked up in `packed-refs` under `packedStamp`; null when none recorded. */
  packedRefs: Map<string, string | null>
  listingStamp: string | null
  entryNames: string[] | null
  entries: Map<string, DerivedRowMemo>
  main: DerivedRowMemo | null
}

/** Git-derived rows plus the stat signature that decides whether Git must run again. */
export type GitDerivationState = {
  entryNames: string[] | null
  listingStamp: string | null
  signature: AdminStatSignature | undefined
}

export type MembershipSource =
  | { kind: 'files' }
  /** Pinned for the model's lifetime; a rebuilt model (next launch, idle drop) re-tests. */
  | { kind: 'git'; reason: string }

export type MembershipDerivationStart = {
  generation: number
  startedAt: number
}

export type WorktreeMembershipModel = {
  key: string
  repoPath: string
  /** Empty until the first build resolves it. */
  commonDir: string
  /** The common dir's realpath, compared form: how sibling registered repos find each other. */
  commonDirKey: string
  /** Git's own main row path and bareness, from the model's one baseline listing. */
  main: { path: string; isBare: boolean }
  source: MembershipSource
  files: FileDerivationState | null
  git: GitDerivationState
  /** Every row, main first, create preparations included; callers filter. */
  rows: GitWorktreeInfo[]
  /** When and at which generation the derivation that produced `rows` started. */
  validated: MembershipDerivationStart
  fullDerivedAt: number
  lastReadAt: number
  /** Bumped by every Orca mutation mark; a result from an older generation is never reused. */
  generation: number
  /** An Orca mark owes a listing re-read (readdir, primary HEAD) whatever the stats say. */
  listingOwed: boolean
  /** The first build, until it settles; resolves stamps, not rows, when files cannot place it. */
  building:
    | (MembershipDerivationStart & {
        work: PromiseSettlementWaiters<GitWorktreeInfo[] | UnplacedRepo>
      })
    | null
  /** The one derivation running, if any. */
  inFlight:
    | (MembershipDerivationStart & { work: PromiseSettlementWaiters<GitWorktreeInfo[]> })
    | null
  /** The derivation queued to start once `inFlight` settles, shared by every reader waiting on it. */
  followUp: PromiseSettlementWaiters<GitWorktreeInfo[]> | null
  startedDerivations: number
  committedDerivation: number
}
