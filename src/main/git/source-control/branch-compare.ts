import type {
  GitBranchCompareResult,
  GitBranchCompareSummary
} from '../../../shared/git-diff-compare-types'
import { readBranchCompareHead } from '../../../shared/git-branch-compare-head'
import { resolveWorktreeAddBaseRef } from '../../../shared/worktree/base-ref'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { resolveWorktreeBaseCommitOid } from '../worktree-base-ref-probe'
import { loadBranchChanges } from './branch-change-entries'
import {
  countAheadCommits,
  resolveCompareRef,
  resolveMergeBase,
  resolveRefOid
} from './compare-ref-oids'

export async function getBranchCompare(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions = {}
): Promise<GitBranchCompareResult> {
  const summary: GitBranchCompareSummary = {
    baseRef,
    baseOid: null,
    compareRef: 'HEAD',
    headOid: null,
    mergeBase: null,
    changedFiles: 0,
    status: 'loading'
  }

  // The base-ref probe peels to a commit. Only branch refs are guaranteed to store
  // commits; remote-tracking refs may store annotated tags whose raw oid must be preserved.
  const reusableProbedOidByRef = new Map<string, string>()
  const { compareRef, headOidResult, baseOidResult } = await readBranchCompareHead({
    readCompareRef: () => resolveCompareRef(worktreePath, options),
    resolveBaseRef: () =>
      // Why: short refs like "origin/main" can collide with a local branch; use the proven remote-tracking ref.
      resolveWorktreeAddBaseRef(baseRef, async (qualifiedRef) => {
        const oid = await resolveWorktreeBaseCommitOid(worktreePath, qualifiedRef, options)
        if (oid !== null && qualifiedRef.startsWith('refs/heads/')) {
          reusableProbedOidByRef.set(qualifiedRef, oid)
        }
        return oid !== null
      }),
    readHeadOid: () => resolveRefOid(worktreePath, 'HEAD', options),
    readBaseOid: (ref) => {
      const reusableOid = reusableProbedOidByRef.get(ref)
      return reusableOid === undefined
        ? resolveRefOid(worktreePath, ref, options)
        : Promise.resolve(reusableOid)
    }
  })
  summary.compareRef = compareRef

  let headOid = ''
  let baseOid = ''
  if (headOidResult.ok) {
    headOid = headOidResult.oid
    summary.headOid = headOid
  } else {
    if (baseOidResult.ok) {
      baseOid = baseOidResult.oid
      summary.baseOid = baseOid
      // Why: an unborn branch (new remote worktree) has no changes yet; a compare error would look broken.
      summary.changedFiles = 0
      summary.commitsAhead = 0
      summary.status = 'ready'
      return { summary, entries: [] }
    }
    summary.status = 'unborn-head'
    summary.errorMessage =
      'This branch does not have a committed HEAD yet, so compare-to-base is unavailable.'
    return { summary, entries: [] }
  }

  if (baseOidResult.ok) {
    baseOid = baseOidResult.oid
    summary.baseOid = baseOid
  } else {
    summary.status = 'invalid-base'
    summary.errorMessage = `Base ref ${baseRef} could not be resolved in this repository.`
    return { summary, entries: [] }
  }

  let mergeBase = ''
  try {
    mergeBase = await resolveMergeBase(worktreePath, baseOid, headOid, options)
    summary.mergeBase = mergeBase
  } catch {
    summary.status = 'no-merge-base'
    summary.errorMessage = `This branch and ${baseRef} do not share a merge base, so compare-to-base is unavailable.`
    return { summary, entries: [] }
  }

  try {
    const [entries, commitsAhead] = await Promise.all([
      loadBranchChanges(worktreePath, mergeBase, headOid, options),
      countAheadCommits(worktreePath, baseOid, headOid, options)
    ])
    summary.changedFiles = entries.length
    summary.commitsAhead = commitsAhead
    summary.status = 'ready'
    return { summary, entries }
  } catch (error) {
    summary.status = 'error'
    summary.errorMessage = error instanceof Error ? error.message : 'Failed to load branch compare'
    return { summary, entries: [] }
  }
}
