/**
 * A WSL host's own Claude launches refresh the selected account folder from the distro user's
 * ~/.claude first, as the desktop's launches into the distro do. Without it the folder stays as it
 * was when the account was added: Claude replays its first-run screens and misses settings changes.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import type { HostAccountLaunchEnv } from '../../shared/host-account-launch-env'
import { claudeProfileMarkerPath } from '../claude-accounts/claude-profile-paths'
import type { ClaudeProfileSetupReport } from '../claude-accounts/claude-profile-setup'
import { wslClaudeProfile } from '../claude-accounts/claude-profile-wsl-paths'
import { provisionWslClaudeAccountProfile } from '../claude-accounts/claude-profile-wsl-provision'

/** The desktop router's cap: a slow refresh delays a launch this long, then runs alongside it. */
const REFRESH_WAIT_MS = 5_000

type Provision = (
  userHome: string,
  distro: string,
  accountId: string
) => Promise<ClaudeProfileSetupReport>

export function createWslHostClaudeProfileRefresh(
  args: {
    userHome?: string
    provision?: Provision
    hasMarker?: (markerPath: string) => boolean
    waitMs?: number
  } = {}
): (launchEnv: HostAccountLaunchEnv) => Promise<void> {
  const userHome = args.userHome ?? homedir()
  const provision = args.provision ?? provisionWslClaudeAccountProfile
  const hasMarker = args.hasMarker ?? existsSync
  const running = new Map<string, Promise<void>>()

  return async (launchEnv) => {
    const configDir = launchEnv.claude.CLAUDE_CONFIG_DIR
    if (!configDir) {
      return
    }
    const accountId = posix.basename(posix.dirname(configDir))
    let profile: ReturnType<typeof wslClaudeProfile>['profile']
    try {
      profile = wslClaudeProfile(userHome, launchEnv.wslDistro, accountId).profile
    } catch {
      // Not an Orca account folder (its id does not parse): nothing of ours to refresh.
      return
    }
    // Why both: only Orca's own folder for this account is rewritten, and only one the desktop
    // already set up; a missing folder is the desktop's to create when the account is added.
    if (profile.home !== configDir || !hasMarker(claudeProfileMarkerPath(profile))) {
      return
    }
    let refresh = running.get(accountId)
    if (!refresh) {
      refresh = provision(userHome, launchEnv.wslDistro, accountId)
        .then((report) => {
          if (report.outcome !== 'prepared' || report.warnings.length > 0) {
            console.warn('[claude-profile] WSL host account refresh was incomplete:', report)
          }
        })
        .catch((error: unknown) => {
          console.warn('[claude-profile] WSL host account refresh failed:', error)
        })
        .finally(() => running.delete(accountId))
      running.set(accountId, refresh)
    }
    // Why capped and never thrown: a set-up folder runs on its last refresh rather than not at all.
    const waitMs = args.waitMs ?? REFRESH_WAIT_MS
    await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, waitMs).unref())])
  }
}
