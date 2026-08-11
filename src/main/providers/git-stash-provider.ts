import type {
  GitStashEntry,
  GitStashMutationResult,
  GitStashPushOptions,
  GitStashPushResult
} from '../../shared/git-stash-types'

/**
 * Stash half of the git provider contract, split into its own module so
 * `types.ts` stays under its max-lines cap.
 *
 * `ref: null` on apply/pop targets the newest entry. `expectedCommitOid` is the
 * oid the caller saw when it picked the entry — implementations reject the
 * operation when it no longer matches, so a concurrent stash in the same
 * worktree cannot silently retarget a destructive action.
 */
export type GitStashProvider = {
  listStashes(worktreePath: string): Promise<GitStashEntry[]>
  stashChanges(worktreePath: string, pushOptions?: GitStashPushOptions): Promise<GitStashPushResult>
  applyStash(
    worktreePath: string,
    ref: string | null,
    expectedCommitOid?: string
  ): Promise<GitStashMutationResult>
  popStash(
    worktreePath: string,
    ref: string | null,
    expectedCommitOid?: string
  ): Promise<GitStashMutationResult>
  dropStash(worktreePath: string, ref: string, expectedCommitOid?: string): Promise<void>
  clearStashes(worktreePath: string): Promise<void>
}
