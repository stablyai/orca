import { isDeepStrictEqual } from 'node:util'
import type { OrcaCloudTeamPolicy } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import type { UpdateCheckVariant } from '../lifecycle/updater-types'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'
import { getVersionChannel, normalizeTagToVersion } from '../../../shared/updater/release-channel'

export type TeamUpdatePolicy = Pick<
  OrcaCloudTeamPolicy,
  | 'updateChannel'
  | 'updateDelayDays'
  | 'minimumVersion'
  | 'forceUpdates'
  | 'forceUpdateDelayDays'
  | 'forceUsesMemberDelay'
  | 'restartDeadlineHours'
> & {
  orgIds: readonly string[]
  emergency?: true
}

export type TeamUpdateApproval = {
  policy: TeamUpdatePolicy | undefined
  tags: readonly string[]
}

export function managesUpdates(policy: TeamUpdatePolicy | undefined): boolean {
  return (
    policy?.updateChannel !== undefined ||
    policy?.updateDelayDays !== undefined ||
    policy?.minimumVersion !== undefined ||
    policy?.forceUpdates === true
  )
}

export function sameTeamUpdatePolicy(
  left: TeamUpdatePolicy | undefined,
  right: TeamUpdatePolicy | undefined
): boolean {
  return (
    isDeepStrictEqual(left?.orgIds, right?.orgIds) &&
    left?.updateChannel === right?.updateChannel &&
    left?.updateDelayDays === right?.updateDelayDays &&
    left?.minimumVersion === right?.minimumVersion &&
    left?.forceUpdates === right?.forceUpdates &&
    left?.forceUpdateDelayDays === right?.forceUpdateDelayDays &&
    left?.forceUsesMemberDelay === right?.forceUsesMemberDelay &&
    left?.restartDeadlineHours === right?.restartDeadlineHours &&
    left?.emergency === right?.emergency
  )
}

export function applyEmergencyUpdateFloor(
  team: TeamUpdatePolicy | undefined,
  minimum: string | null,
  currentVersion: string
): TeamUpdatePolicy | undefined {
  if (!team?.orgIds.length || !minimum || !isValidVersion(currentVersion)) {
    return team
  }
  const channel = getVersionChannel(minimum)
  if ((channel !== 'stable' && channel !== 'rc') || compareVersions(currentVersion, minimum) >= 0) {
    return team
  }
  return {
    orgIds: team.orgIds,
    updateChannel: channel,
    updateDelayDays: 0,
    minimumVersion: minimum,
    emergency: true
  }
}

export function requiredMinimumVersion(
  policy: TeamUpdatePolicy | undefined,
  currentVersion: string
): string | undefined {
  const minimum = policy?.minimumVersion
  return minimum && isValidVersion(currentVersion) && compareVersions(currentVersion, minimum) < 0
    ? minimum
    : undefined
}

export function requiresTeamRelease(
  policy: TeamUpdatePolicy | undefined,
  currentVersion: string,
  version: string
): boolean {
  const minimum = requiredMinimumVersion(policy, currentVersion)
  return (minimum || policy?.forceUpdates === true) && compareVersions(version, currentVersion) > 0
    ? !minimum || compareVersions(version, minimum) >= 0
    : false
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
      sameTeamUpdatePolicy(approval?.policy, policy) &&
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
}): {
  isPerfCheck: boolean
  includePrerelease: boolean
  delayDays: number
  minimumVersion?: string
} {
  const isPerfCheck = variant === 'perf' && !managesUpdates(team)
  const minimumVersion = requiredMinimumVersion(team, version)
  const forced = team?.forceUpdates === true
  const usesMemberDelay = forced
    ? team.forceUsesMemberDelay === true || team.forceUpdateDelayDays === undefined
    : team?.updateDelayDays === undefined && !isPerfCheck && (!ignoreDelay || !!minimumVersion)
  let memberDelay = 0
  if (usesMemberDelay) {
    try {
      memberDelay = getUpdateDelayDays?.() ?? 0
    } catch {
      // A settings read failure must not block updates entirely.
    }
  }
  let delayDays = memberDelay
  if (forced) {
    const forceDelay = team.forceUpdateDelayDays
    delayDays = usesMemberDelay
      ? Math.min(memberDelay, forceDelay ?? memberDelay)
      : (forceDelay ?? 0)
  } else if (team?.updateDelayDays !== undefined) {
    delayDays = Math.min(team.updateDelayDays, 30)
  }
  return {
    isPerfCheck,
    includePrerelease:
      team?.updateChannel !== undefined
        ? team.updateChannel === 'rc'
        : isPerfCheck || includePrerelease || isPrereleaseVersion(version),
    delayDays,
    ...(minimumVersion ? { minimumVersion } : {})
  }
}
