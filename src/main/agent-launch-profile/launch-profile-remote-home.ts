import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { assignLaunchProfileHome, requestedSecondaryHomeProfiles } from './launch-profile-home'
import { AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED } from './requested-launch-profile'

export type LaunchProfileRemoteHost = {
  remoteHome?: string
  hostPlatform?: RemoteHostPlatform
}

/**
 * Resolves secondary-home markers for a PTY that spawns on an SSH host.
 *
 * The SSH env travels to the relay as a literal JSON map, so nothing there expands `$HOME`.
 * The session probed the remote home and platform when it connected; that probe is the
 * execution host's own answer, so the path is joined here in the host's flavor. The remote's
 * `ORCA_*_SECONDARY_HOME` override is not consulted: this runtime cannot read a remote env.
 */
export function applyLaunchProfileHomeMarkersForRemoteHost(
  env: Record<string, string>,
  host: LaunchProfileRemoteHost | undefined
): void {
  for (const profile of requestedSecondaryHomeProfiles(env)) {
    // Why: without the probe the only alternative is the remote default home, which is exactly
    // the home the user asked not to use; fail the launch instead.
    if (!host?.remoteHome || !host.hostPlatform) {
      throw new Error(AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED)
    }
    assignLaunchProfileHome(
      env,
      profile,
      joinRemotePath(host.hostPlatform, host.remoteHome, profile.home.dirName)
    )
  }
}
