import type {
  GitBranchCompareResult,
  GitBranchCompareSummary
} from '../../../../shared/git/diff/git-diff-compare-types'
import { readBranchCompareHead } from '../../../../shared/git/branches/git-branch-compare-head'
import { resolveWorktreeAddBaseRef } from '../../../../shared/worktree/base-refs/base-ref'
import type { GitRuntimeOptions } from '../../command-runner/git-runtime-options'
import { resolveWorktreeBaseCommitOid } from '../../worktrees/creation/worktree-base-ref-probe'
import { loadBranchChangesThroughCache } from './branch-change-list-cache'
import {
  commitPairDivergences,
  commitPairMergeBases,
  readCommitPairScope,
  rememberCommitPair
} from './commit-pair-cache'
import {
  countCompareDivergence,
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

  // Never rejects; read alongside ref resolution so cache hits add no latency.
  const pairScopePromise = readCommitPairScope(worktreePath, options)
  // Reuse peeled commit OIDs only for branch refs; remote-tracking refs may hold annotated tags.
  const reusableProbedOidByRef = new Map<string, string>()
  const { compareRef, headOidResult, baseOidResult } = await readBranchCompareHead({
    readCompareRef: () => resolveCompareRef(worktreePath, options),
    resolveBaseRef: () =>
      // Short remote names can collide with local branches; resolve the qualified ref.
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
      // An unborn branch has no changes to compare.
      summary.changedFiles = 0
      summary.commitsAhead = 0
      summary.commitsBehind = 0
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

  // Polls re-resolve only the refs; history walks rerun when a tip moves.
  const pairScope = await pairScopePromise
  const rereadPairScope = () => readCommitPairScope(worktreePath, options)
  let mergeBase = ''
  try {
    mergeBase = await rememberCommitPair(
      commitPairMergeBases,
      pairScope,
      rereadPairScope,
      baseOid,
      headOid,
      () => resolveMergeBase(worktreePath, baseOid, headOid, options)
    )
    summary.mergeBase = mergeBase
  } catch {
    summary.status = 'no-merge-base'
    summary.errorMessage = `This branch and ${baseRef} do not share a merge base, so compare-to-base is unavailable.`
    return { summary, entries: [] }
  }

  try {
    // Git must confirm equal raw tips are the same commit before skipping the reads.
    if (baseOid === headOid && summary.mergeBase === headOid) {
      options.signal?.throwIfAborted()
      summary.commitsAhead = 0
      summary.commitsBehind = 0
      summary.status = 'ready'
      return { summary, entries: [] }
    }

    const [entries, divergence] = await Promise.all([
      loadBranchChangesThroughCache(
        worktreePath,
        pairScope,
        rereadPairScope,
        mergeBase,
        headOid,
        options
      ),
      rememberCommitPair(commitPairDivergences, pairScope, rereadPairScope, baseOid, headOid, () =>
        countCompareDivergence(worktreePath, baseOid, headOid, options)
      )
    ])
    summary.changedFiles = entries.length
    summary.commitsAhead = divergence.ahead
    summary.commitsBehind = divergence.behind
    summary.status = 'ready'
    return { summary, entries }
  } catch (error) {
    summary.status = 'error'
    summary.errorMessage = error instanceof Error ? error.message : 'Failed to load branch compare'
    return { summary, entries: [] }
  }
}
