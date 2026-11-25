import { isDeepStrictEqual } from 'node:util'
import { getActiveTeamProfileScope } from '../../orca-profiles/cloud-auth/active-team-capabilities'
import type { OrcaCloudSessionIdentity } from '../../orca-profiles/cloud-session/profile-cloud-session-store'

type TeamProfile = NonNullable<ReturnType<typeof getActiveTeamProfileScope>>

let report: { profile: TeamProfile; pluginKeys: readonly string[] } | undefined
let notified: { profile: TeamProfile; pluginKeys: Set<string> } | undefined

export function recordRequiredPluginFailures(
  profile: TeamProfile | undefined,
  pluginKeys: readonly string[] | undefined
): boolean {
  const next =
    profile && pluginKeys && isDeepStrictEqual(profile, getActiveTeamProfileScope())
      ? { profile, pluginKeys }
      : undefined
  if (isDeepStrictEqual(report, next)) {
    return false
  }
  report = next
  if (!profile || !isDeepStrictEqual(notified?.profile, profile)) {
    notified = undefined
  } else if (notified && next) {
    const failures = new Set(next.pluginKeys)
    notified.pluginKeys = new Set([...notified.pluginKeys].filter((key) => failures.has(key)))
  }
  return true
}

function activeReport(): typeof report {
  return report && isDeepStrictEqual(report.profile, getActiveTeamProfileScope())
    ? report
    : undefined
}

export function takeRequiredPluginFailures(): { pluginKeys: readonly string[]; notify: boolean } {
  const active = activeReport()
  if (!active) {
    return { pluginKeys: [], notify: false }
  }
  const { profile, pluginKeys } = active
  if (!notified || !isDeepStrictEqual(notified.profile, profile)) {
    notified = { profile, pluginKeys: new Set() }
  }
  const previous = notified.pluginKeys
  const notify = pluginKeys.some((key) => !previous.has(key))
  notified.pluginKeys = new Set(pluginKeys)
  return { pluginKeys, notify }
}

export function getRequiredPluginFailureHeader(
  identity: OrcaCloudSessionIdentity | undefined
): string | undefined {
  const active = activeReport()
  if (
    !active ||
    identity?.userId !== active.profile.userId ||
    identity.cloudProfileId !== active.profile.cloudProfileId
  ) {
    return undefined
  }
  // Limit ASCII wire size and send whole keys only.
  const keys: string[] = []
  let bytes = 0
  for (const key of active.pluginKeys) {
    const next = bytes + key.length + Number(keys.length > 0)
    if (next > 4096 || keys.length === 128) {
      break
    }
    keys.push(key)
    bytes = next
  }
  return keys.join(',')
}
