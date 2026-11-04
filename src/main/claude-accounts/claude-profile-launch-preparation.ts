import { existsSync } from 'node:fs'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  claudeProfileMarkerPath,
  describeClaudeProfile,
  type ClaudeProfileDescriptor
} from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import { claudeProfileSetupFailed } from './claude-profile-launch-errors'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

/** First construction requires setup; a prepared profile keeps its existing bounded refresh behavior. */
export async function prepareClaudeProfileForLaunch(
  profile: ClaudeProfileDescriptor,
  setUp: (profile: ClaudeProfileDescriptor) => Promise<ClaudeProfileSetupReport>,
  waitMs = 5_000
): Promise<void> {
  if (!existsSync(claudeProfileMarkerPath(profile))) {
    const report = await setUp(profile).catch(() => null)
    if (report?.outcome !== 'prepared') {
      throw claudeProfileSetupFailed()
    }
    return
  }
  const refresh = setUp(profile).catch((error: unknown) => {
    console.warn('[claude-profile] Account refresh failed:', error)
  })
  await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, waitMs).unref())])
}

type SystemDefaultRefreshArgs = {
  getSettings: () => Pick<
    GlobalSettings,
    | 'claudeManagedAccounts'
    | 'activeClaudeManagedAccountId'
    | 'activeClaudeManagedAccountIdsByRuntime'
  >
  dataRoot: string
  refreshWaitMs?: number
}

/** Any set-up host account refreshes every account with the user's files; never creates one. */
export function systemDefaultRefreshProfile(
  args: SystemDefaultRefreshArgs
): ClaudeProfileDescriptor | null {
  const settings = args.getSettings()
  const selected = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  const ids = settings.claudeManagedAccounts
    .filter((account) => account.managedAuthRuntime !== 'wsl')
    .map((account) => account.id)
  for (const id of selected ? [selected, ...ids] : ids) {
    try {
      const profile = describeClaudeProfile(args.dataRoot, id, {
        executionHostId: 'local',
        runtime: 'host'
      })
      if (existsSync(claudeProfileMarkerPath(profile))) {
        return profile
      }
    } catch {
      // An unusable saved id has no folder to refresh.
    }
  }
  return null
}

/** Changes saved on an account must reach System default; a slow refresh never fails the launch. */
export async function refreshClaudeAccountsForSystemDefault(
  args: SystemDefaultRefreshArgs,
  setUp: (profile: ClaudeProfileDescriptor) => Promise<ClaudeProfileSetupReport>
): Promise<void> {
  const profile = systemDefaultRefreshProfile(args)
  if (!profile) {
    return
  }
  const refresh = setUp(profile).catch((error: unknown) => {
    console.warn('[claude-profile] Account refresh failed:', error)
  })
  const waitMs = args.refreshWaitMs ?? 5_000
  await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, waitMs).unref())])
}
