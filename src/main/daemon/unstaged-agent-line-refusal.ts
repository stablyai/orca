import type { UnstageableLine } from '../../shared/launch-prompt-file'
import {
  startupLineNeedsStaging,
  type StartupCommandStaging
} from '../../shared/startup-command-staging'

/**
 * Why the daemon refuses an agent line it did not stage, or null to type it as is. A write that
 * failed in a folder that looked usable is a race, refused for every caller. A folder already
 * unusable gets the line its plan chose, typed, unless the caller asked to refuse it
 * (`UnstageableLine`); a WSL spawn with no distro folder never tried to stage.
 */
export function unstagedAgentLineRefusal(args: {
  command: string
  staging: StartupCommandStaging
  agentLaunch: boolean
  unstageableLine: UnstageableLine | undefined
  wslWithoutFolder: boolean
}): string | null {
  const { staging } = args
  if (!args.agentLaunch) {
    return null
  }
  if (staging.failure !== undefined && staging.folderUnusable !== true) {
    return staging.failure
  }
  if (args.unstageableLine !== 'refuse') {
    return null
  }
  if (staging.failure !== undefined) {
    return staging.failure
  }
  return args.wslWithoutFolder && startupLineNeedsStaging(args.command)
    ? "the WSL distro's home directory could not be reached"
    : null
}
