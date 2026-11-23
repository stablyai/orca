import { isDeepStrictEqual } from 'node:util'
import type { OrcaCloudTeamPolicy } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import type { UpdateCheckVariant } from '../lifecycle/updater-types'
import { isPrereleaseVersion } from './updater-fallback'
import { normalizeTagToVersion } from '../../../shared/updater/release-channel'

export type TeamUpdatePolicy = Pick<OrcaCloudTeamPolicy, 'updateChannel' | 'updateDelayDays'> & {
  orgIds: readonly string[]
}

export type TeamUpdateApproval = {
  policy: TeamUpdatePolicy | undefined
  tags: readonly string[]
}

export function managesUpdates(policy: TeamUpdatePolicy | undefined): boolean {
  return policy?.updateChannel !== undefined || policy?.updateDelayDays !== undefined
}

export function teamAllowsUpdate(
  policy: TeamUpdatePolicy | undefined,
  approval: TeamUpdateApproval | null,
  version: string,
  routineRelease: boolean
): boolean {
  return (
    !managesUpdates(policy) ||
    (routineRelease &&
      isDeepStrictEqual(approval?.policy?.orgIds, policy?.orgIds) &&
      approval?.policy?.updateChannel === policy?.updateChannel &&
      approval?.policy?.updateDelayDays === policy?.updateDelayDays &&
      approval?.tags.some((tag) => normalizeTagToVersion(tag) === version) === true)
  )
}

export function releaseSelectionPolicy({
  team,
  variant,
  version,
  includePrerelease,
  ignoreDelay,
  getUpdateDelayDays
}: {
  team: TeamUpdatePolicy | undefined
  variant: UpdateCheckVariant
  version: string
  includePrerelease: boolean
  ignoreDelay: boolean
  getUpdateDelayDays: (() => number) | null
}): { isPerfCheck: boolean; includePrerelease: boolean; delayDays: number } {
  const isPerfCheck = variant === 'perf' && !managesUpdates(team)
  let delayDays = team?.updateDelayDays ?? 0
  if (team?.updateDelayDays === undefined && !isPerfCheck && !ignoreDelay) {
    try {
      delayDays = getUpdateDelayDays?.() ?? 0
    } catch {
      // A settings read failure must not block updates entirely.
    }
  }
  return {
    isPerfCheck,
    includePrerelease:
      team?.updateChannel !== undefined
        ? team.updateChannel === 'rc'
        : isPerfCheck || includePrerelease || isPrereleaseVersion(version),
    delayDays
  }
}
