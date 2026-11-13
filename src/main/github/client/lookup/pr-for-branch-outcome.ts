import {
  withGitHubRepoExecution,
  captureGitHubRepoExecution,
  outsideGitHubRepoExecution
} from '../../repositories/github-repository-identity'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { acquire, release } from '../../execution/github-operation-slots'

import { hostedReviewLocalGitOptionArgs } from './../github-exec-scope'
import type { GitHubPRBranchLookupOptions } from './pull-request-lookup-data'
import { prRefreshUpstreamError } from './../gh-error-predicates'
import { resolvePRForBranchOutcome } from './branch-lookup-resolution'
import {
  readRecentOpenPROutcome,
  readTimedPROutcome,
  canRetainPROutcome,
  beginExactPRLookup,
  releaseExactPRLookup,
  holdExactPROutcome,
  scheduleExactPRError,
  recordPRLastOutcome,
  startPRLookup
} from './pr-last-outcome'
import { prLookupScope, lastOutcomeKey, completeReadKey } from './pr-read-identity'
import { refreshPRPolicyContext, recordPRPolicyOutcome } from './pr-quiet-policy-evidence'
import {
  hostedReviewRepoScope,
  scopeGeneration
} from '../../../source-control/hosted-review-scope-generations'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
const reads: CoalescedProbes<PRRefreshOutcome> = new Map()
class PRLookupRetentionRefused extends Error {}

/** A phone read may take the last lookup's open PR; it was already observed when it was looked up. */
export async function readRecentPhonePROutcome(
  repoPath: string,
  branch: string,
  linkedPRNumber: number | null,
  connectionId: string | null,
  fallbackPRNumber: number | null,
  options: GitHubPRBranchLookupOptions
): Promise<PRRefreshOutcome | null> {
  if (options.userRefresh === true) {
    return null
  }
  return withGitHubRepoExecution(
    repoPath,
    connectionId,
    hostedReviewLocalGitOptionArgs(options)[0] ?? {},
    async () =>
      readRecentOpenPROutcome(
        lastOutcomeKey(
          repoPath,
          branch.replace(/^refs\/heads\//, ''),
          prLookupScope(repoPath, connectionId, options)
        ),
        {
          linkedPRNumber,
          fallbackPRNumber: linkedPRNumber === null ? fallbackPRNumber : null,
          currentHeadOid: options.currentHeadOid ?? null
        }
      )
  )
}

export async function preparePRBranchRead(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  fallbackPRNumber?: number | null,
  options: GitHubPRBranchLookupOptions = {}
): Promise<PreparedPRBranchRead> {
  options = {
    ...options,
    ...(options.localGitExecOptions
      ? {
          localGitExecOptions: {
            ...options.localGitExecOptions,
            ...(options.localGitExecOptions.ghAccount
              ? { ghAccount: { ...options.localGitExecOptions.ghAccount } }
              : {})
          }
        }
      : {}),
    ...(options.sharedLinkPaths ? { sharedLinkPaths: [...options.sharedLinkPaths] } : {}),
    ...(options.exactRepository ? { exactRepository: { ...options.exactRepository } } : {})
  }
  const reprepare = () =>
    outsideGitHubRepoExecution(() =>
      preparePRBranchRead(repoPath, branch, linkedPRNumber, connectionId, fallbackPRNumber, options)
    )
  return withGitHubRepoExecution(
    repoPath,
    connectionId,
    hostedReviewLocalGitOptionArgs(options)[0] ?? {},
    async (): Promise<PreparedPRBranchRead> => {
      const withExecution = captureGitHubRepoExecution()
      const branchName = branch.replace(/^refs\/heads\//, '')
      // Detached HEAD cannot discover by branch, but explicit PR numbers remain safe.
      if (
        !branchName &&
        typeof linkedPRNumber !== 'number' &&
        typeof fallbackPRNumber !== 'number'
      ) {
        return {
          key: '',
          reprepare,
          cached: () => null,
          isCurrent: () => true,
          accepts: () => true,
          didRead: () => false,
          release: () => {},
          hold: () => () => {},
          readRetained: async () => ({ kind: 'no-pr', fetchedAt: Date.now() }),
          canRetain: () => true,
          scheduleError: () => {},
          pending: () => null,
          withExecution,
          read: async () => ({ kind: 'no-pr', fetchedAt: Date.now() })
        }
      }
      const policyRevision = refreshPRPolicyContext()
      const scope = prLookupScope(repoPath, connectionId, options)
      const { localGitOptions, ghOptions, executionScope } = scope
      const key = completeReadKey(
        repoPath,
        branchName,
        linkedPRNumber,
        fallbackPRNumber,
        options,
        scope
      )
      const ownerKey = lastOutcomeKey(repoPath, branchName, scope)
      const freshKey = `${key}::fresh`
      const timedKey = `${key}::timed`
      const coalescingKey = options.resetQuietBackoff || options.userRefresh ? freshKey : timedKey
      const pendingAt = (key: string) => {
        const pending = reads.get(key)
        return pending && Date.now() - pending.startedAt < 2 * 60_000 ? pending.promise : null
      }
      const narrowed =
        options.checkPageLimit !== undefined ||
        options.exactRepository ||
        options.includeDerivedData === false
      let didRead = false
      const readCore = (requireRetention = false, settle?: PRReadSettlement) =>
        withExecution(
          () =>
            (!options.userRefresh && coalescingKey === timedKey ? pendingAt(freshKey) : null) ??
            runCoalescedProbe(
              reads,
              coalescingKey,
              async (ownsKey) => {
                const start = startPRLookup()
                const retained =
                  !narrowed &&
                  beginExactPRLookup(
                    ownerKey,
                    key,
                    start,
                    options.resetQuietBackoff || options.userRefresh
                  )
                if (requireRetention && !retained) {
                  throw new PRLookupRetentionRefused()
                }
                didRead = true
                try {
                  await acquire()
                  let outcome: PRRefreshOutcome
                  try {
                    outcome = await resolvePRForBranchOutcome({
                      repoPath,
                      branchName,
                      linkedPRNumber,
                      connectionId,
                      fallbackPRNumber,
                      options,
                      localGitOptions,
                      ghOptions,
                      executionScope
                    })
                  } catch (err) {
                    outcome = prRefreshUpstreamError(err)
                  } finally {
                    release()
                  }
                  recordPRLastOutcome(ownerKey, {
                    start,
                    requestKey: key,
                    currentHeadOid: options.currentHeadOid ?? null,
                    resetQuiet: options.userRefresh === true || options.resetQuietBackoff === true,
                    linkedPRNumber: linkedPRNumber ?? null,
                    fallbackPRNumber: fallbackPRNumber ?? null,
                    outcome: narrowed ? null : outcome
                  })
                  if (!narrowed) {
                    recordPRPolicyOutcome(outcome, {
                      revision: policyRevision,
                      current: () =>
                        scopeGeneration(
                          hostedReviewRepoScope(repoPath, getRepoExecutionHostId({ connectionId }))
                        ) === scope.generation,
                      cached: () => readTimedPROutcome(ownerKey, key)
                    })
                  }
                  return settle &&
                    (retained ? readTimedPROutcome(ownerKey, key)?.outcome === outcome : ownsKey())
                    ? settle(outcome, { retained })
                    : outcome
                } finally {
                  if (retained) {
                    releaseExactPRLookup(key, start.sequence)
                  }
                }
              },
              2 * 60_000,
              { userRefresh: options.userRefresh === true }
            )
        )
      const read = async (settle?: PRReadSettlement): Promise<PRRefreshOutcome> => {
        try {
          return await readCore(false, settle)
        } catch (error) {
          if (!(error instanceof PRLookupRetentionRefused)) {
            throw error
          }
          return readCore(false, settle)
        }
      }
      const readRetained = async (settle?: PRReadSettlement): Promise<PRRefreshOutcome | null> => {
        try {
          return await readCore(true, settle)
        } catch (error) {
          if (!(error instanceof PRLookupRetentionRefused)) {
            throw error
          }
          return null
        }
      }
      return {
        key,
        reprepare,
        cached: () => readTimedPROutcome(ownerKey, key),
        isCurrent: () =>
          outsideGitHubRepoExecution(
            () =>
              lastOutcomeKey(
                repoPath,
                branchName,
                prLookupScope(repoPath, connectionId, options)
              ) === ownerKey
          ),
        accepts: (outcome) => readTimedPROutcome(ownerKey, key)?.outcome === outcome,
        didRead: () => didRead,
        release: () => {},
        hold: () => holdExactPROutcome(key),
        readRetained,
        canRetain: () => canRetainPROutcome(key),
        scheduleError: (expected, outcome) => scheduleExactPRError(key, expected, outcome),
        pending: () => pendingAt(freshKey) ?? pendingAt(timedKey),
        withExecution,
        read
      }
    }
  )
}

export type PRReadSettlement = (
  outcome: PRRefreshOutcome,
  producer: { retained: boolean }
) => PRRefreshOutcome

export type PreparedPRBranchRead = {
  key: string
  reprepare: () => Promise<PreparedPRBranchRead>
  cached: () => ReturnType<typeof readTimedPROutcome>
  isCurrent: () => boolean
  accepts: (outcome: PRRefreshOutcome) => boolean
  didRead: () => boolean
  release: () => void
  hold: () => () => void
  readRetained: (settle?: PRReadSettlement) => Promise<PRRefreshOutcome | null>
  canRetain: () => boolean
  scheduleError: (expected: PRRefreshOutcome, outcome: PRRefreshOutcome) => void
  pending: () => Promise<PRRefreshOutcome> | null
  withExecution: <T>(operation: () => Promise<T>) => Promise<T>
  read: (settle?: PRReadSettlement) => Promise<PRRefreshOutcome>
}

export async function getPRForBranchOutcome(
  ...args: Parameters<typeof preparePRBranchRead>
): Promise<PRRefreshOutcome> {
  const prepared = await preparePRBranchRead(...args)
  try {
    return await prepared.read()
  } finally {
    prepared.release()
  }
}
