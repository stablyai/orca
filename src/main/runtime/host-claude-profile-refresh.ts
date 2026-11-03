import type { HostAccountLaunchEnv } from '../../shared/host-account-launch-env'

/** Refreshes a host's selected Claude account folder before a Claude launch it starts. */
export type HostClaudeProfileRefresh = (launchEnv: HostAccountLaunchEnv) => Promise<void>

export async function refreshSelectedClaudeProfile(
  refresh: HostClaudeProfileRefresh,
  selected: () => HostAccountLaunchEnv | null
): Promise<void> {
  // Why twice at most: a switch during the refresh would launch on a folder never refreshed.
  for (let pass = 0, env = selected(); env && pass < 2; pass++) {
    await refresh(env)
    if (selected() === env) {
      return
    }
    env = selected()
  }
}
