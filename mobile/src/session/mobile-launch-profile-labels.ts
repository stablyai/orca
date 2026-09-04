import { BUILT_IN_AGENT_LAUNCH_PROFILES } from '../../../src/shared/agent-launch-profile/agent-launch-profile'

// Why: the tab strip already shows the agent icon, so a built-in label such as
// "Codex · secondary home" only needs its distinguishing half. Custom profiles are host
// settings the device does not hold, so their id is the honest fallback.
export function mobileLaunchProfileBadge(
  launchProfileId: string | null | undefined
): string | null {
  const id = launchProfileId?.trim()
  if (!id) {
    return null
  }
  const builtIn = BUILT_IN_AGENT_LAUNCH_PROFILES.find((profile) => profile.id === id)
  if (!builtIn) {
    return id
  }
  const separator = builtIn.label.indexOf(' · ')
  return separator === -1 ? builtIn.label : builtIn.label.slice(separator + ' · '.length)
}
