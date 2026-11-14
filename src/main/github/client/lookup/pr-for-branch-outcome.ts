import {
  withGitHubRepoExecution,
  captureGitHubRepoExecution,
  outsideGitHubRepoExecution
} from '../../repositories/github-repository-identity'
import { runCoalescedProbe } from '../../../git/remotes/coalesced-probe'
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
import {
  completePRBranchRead,
  pendingPRBranchRead,
  prBranchReadProducer,
  prBranchReadResource,
  retirePRBranchReadResource,
  startPRBranchRead,
  PRLookupRetentionRefused,
  throwUnlessRetentionRefused,
  type PRBranchReadResult,
  type PRReadSettlement,
  type PreparedPRBranchRead
} from './pr-branch-read-resources'

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
          readResult: async () => ({
            outcome: { kind: 'no-pr', fetchedAt: Date.now() },
            sequence: 0,
            current: () => true
          }),
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
      const coalescingKey = options.resetQuietBackoff || options.userRefresh ? 'fresh' : 'timed'
      const pendingAt = (intent: 'fresh' | 'timed') => pendingPRBranchRead(key, intent)
      const isCurrent = () =>
        outsideGitHubRepoExecution(
          () =>
            lastOutcomeKey(repoPath, branchName, prLookupScope(repoPath, connectionId, options)) ===
            ownerKey
        )
      const narrowed =
        options.checkPageLimit !== undefined ||
        options.exactRepository ||
        options.includeDerivedData === false
      let didRead = false
      const readCore = (
        requireRetention: boolean,
        settle?: PRReadSettlement
      ): Promise<PRBranchReadResult> =>
        withExecution(() => {
          const resource = prBranchReadResource(key)
          return (
            (!options.userRefresh && coalescingKey === 'timed' ? pendingAt('fresh') : null) ??
            runCoalescedProbe(
              resource.probes,
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
                const ended = startPRBranchRead(key, resource, start.sequence)
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
                  const producer = prBranchReadProducer(key, resource, start.sequence, isCurrent, {
                    retained,
                    full: !narrowed
                  })
                  // Settled once, only by the newest read of its request, still in scope, whose
                  // result the exact record kept or whose probe it still owns. A result the record
                  // refused (a newer read, or its owner's invalidation) is never current.
                  const refused = retained && readTimedPROutcome(ownerKey, key)?.outcome !== outcome
                  if (refused || (!retained && !ownsKey()) || !producer.current?.()) {
                    return { sequence: start.sequence, current: () => false, outcome }
                  }
                  const settled = settle
                    ? settle(outcome, producer)
                    : completePRBranchRead(outcome, producer, prepared, request)
                  return {
                    sequence: start.sequence,
                    outcome: settled,
                    current: () =>
                      producer.current!() &&
                      (!retained || readTimedPROutcome(ownerKey, key)?.outcome === settled)
                  }
                } finally {
                  if (retained) {
                    releaseExactPRLookup(key, start.sequence)
                  }
                  ended()
                }
              },
              2 * 60_000,
              { userRefresh: options.userRefresh === true }
            ).finally(() => retirePRBranchReadResource(key, resource))
          )
        })
      // A join of a read that had to keep its result, and found no room, reads for itself.
      const readResult = (settle?: PRReadSettlement, requireRetention = false) =>
        readCore(requireRetention, settle).catch((error: unknown) => {
          throwUnlessRetentionRefused(error)
          return requireRetention ? null : readCore(false, settle)
        })
      const request = { repoPath, branch, linkedPRNumber, connectionId, localGitOptions }
      const prepared: PreparedPRBranchRead = {
        key,
        reprepare,
        cached: () => readTimedPROutcome(ownerKey, key),
        isCurrent,
        accepts: (outcome) => readTimedPROutcome(ownerKey, key)?.outcome === outcome,
        didRead: () => didRead,
        release: () => {},
        hold: () => holdExactPROutcome(key),
        readResult,
        canRetain: () => canRetainPROutcome(key),
        scheduleError: (expected, outcome) => scheduleExactPRError(key, expected, outcome),
        pending: () => pendingAt('fresh') ?? pendingAt('timed'),
        withExecution,
        read: async (settle) => (await readResult(settle))!.outcome
      }
      return prepared
    }
  )
}

export type { PRReadSettlement, PreparedPRBranchRead } from './pr-branch-read-resources'

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
