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
  prBranchReadResource,
  pendingPRBranchRead,
  retirePRBranchReadResource,
  startPRBranchRead,
  type PRBranchReadResult,
  type PRReadSettlement,
  type PreparedPRBranchRead
} from './pr-branch-read-resources'
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
      const narrowed =
        options.checkPageLimit !== undefined ||
        options.exactRepository ||
        options.includeDerivedData === false
      let didRead = false
      const readCore = (requireRetention = false, settle?: PRReadSettlement) =>
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
                const producer = startPRBranchRead(key, resource, start.sequence)
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
                  if (
                    settle &&
                    prepared.isCurrent() &&
                    producer.current() &&
                    (retained ? readTimedPROutcome(ownerKey, key)?.outcome === outcome : ownsKey())
                  ) {
                    outcome = settle(outcome, { retained })
                  }
                  return {
                    outcome,
                    sequence: start.sequence,
                    current: () =>
                      producer.current() &&
                      prepared.isCurrent() &&
                      (!retained || prepared.accepts(outcome))
                  }
                } finally {
                  if (retained) {
                    releaseExactPRLookup(key, start.sequence)
                  }
                  producer.finish()
                }
              },
              2 * 60_000,
              { userRefresh: options.userRefresh === true }
            ).finally(() => retirePRBranchReadResource(key, resource))
          )
        })
      const readResult = async (
        settle?: PRReadSettlement,
        requireRetention = false
      ): Promise<PRBranchReadResult | null> => {
        try {
          return await readCore(requireRetention, settle)
        } catch (error) {
          if (!(error instanceof PRLookupRetentionRefused)) {
            throw error
          }
          return requireRetention ? null : readCore(false, settle)
        }
      }
      const read = async (settle?: PRReadSettlement): Promise<PRRefreshOutcome> =>
        (await readResult(settle))!.outcome
      const readRetained = async (settle?: PRReadSettlement): Promise<PRRefreshOutcome | null> =>
        (await readResult(settle, true))?.outcome ?? null
      const prepared: PreparedPRBranchRead = {
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
        readResult,
        canRetain: () => canRetainPROutcome(key),
        scheduleError: (expected, outcome) => scheduleExactPRError(key, expected, outcome),
        pending: () => pendingAt('fresh') ?? pendingAt('timed'),
        withExecution,
        read
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
