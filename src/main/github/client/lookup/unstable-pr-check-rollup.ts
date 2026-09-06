import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { OwnerRepo } from '../../gh-utils'
import { getPRChecksWithExistingOperationPermit } from './../check/get-pr-checks'
import type { HostedReviewLocalGitOptions } from './../github-exec-scope'
import { deriveCheckStatuses, mapPRState } from '../../mappers'
import type { PullRequestLookupData } from './pull-request-lookup-data'

type DetailedCheckLoader = () => Promise<PRCheckDetail[]>

export async function hydrateUnstablePRCheckRollup(
  data: PullRequestLookupData,
  args: {
    repoPath: string
    dataRepo: OwnerRepo | null
    connectionId?: string | null
    localGitOptions: HostedReviewLocalGitOptions
  },
  loadChecks: DetailedCheckLoader = () =>
    getPRChecksWithExistingOperationPermit(
      args.repoPath,
      data.number,
      data.headRefOid,
      args.dataRepo,
      args.connectionId,
      args.localGitOptions
    )
): Promise<PullRequestLookupData> {
  const rollupStatus = deriveCheckStatuses(data.statusCheckRollup).presentationStatus
  const mergeStateStatus = data.mergeStateStatus?.toUpperCase()
  // GitHub can report UNKNOWN with a passing rollup that omits suite-only blockers.
  const rollupMayOmitSuiteOnlyChecks =
    mergeStateStatus === 'UNSTABLE' || mergeStateStatus === 'UNKNOWN'
  if (
    !rollupMayOmitSuiteOnlyChecks ||
    mapPRState(data.state, data.isDraft) !== 'open' ||
    rollupStatus === 'failure' ||
    rollupStatus === 'action_required'
  ) {
    return data
  }

  const neutralFallback = rollupStatus === 'success' ? { ...data, statusCheckRollup: [] } : data
  try {
    const checks = await loadChecks()
    return checks.length > 0 ? { ...data, statusCheckRollup: checks } : neutralFallback
  } catch (error) {
    // An incomplete passing rollup must stay visible without claiming success.
    console.warn('Unable to hydrate incomplete PR checks:', error)
    return neutralFallback
  }
}
