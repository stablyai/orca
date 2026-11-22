import type { OrcaCloudTeamPolicy } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import type { UpdateCheckVariant } from '../lifecycle/updater-types'
import { isPrereleaseVersion } from './updater-fallback'

export type TeamUpdatePolicy = Pick<OrcaCloudTeamPolicy, 'updateChannel' | 'updateDelayDays'>

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
  const isPerfCheck =
    variant === 'perf' && team?.updateChannel === undefined && team?.updateDelayDays === undefined
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
