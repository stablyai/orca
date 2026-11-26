// Dependency-free so profile transfer and offline writes (reachable from the CLI) can seed without the store graph.

/** New profiles open links directly in the system browser and never see the retired first-use prompt. */
export const NEW_PROFILE_LINK_SEED = {
  httpLinkClickBehavior: 'open',
  openLinksInAppPreferencePrompted: true
} as const

/** Seeds a raw profile root that is absent or exactly telemetry-only; returns undefined for anything else. */
export function seedNewProfileLinkMode(
  root: Record<string, unknown> | undefined
): (Record<string, unknown> & { settings: Record<string, unknown> }) | undefined {
  if (root !== undefined && !isTelemetryOnlyProfile(root)) {
    return undefined
  }
  const settings = root && isRecord(root.settings) ? root.settings : {}
  return { ...root, settings: { ...settings, ...NEW_PROFILE_LINK_SEED } }
}

/** Secondary profiles start with only the install's telemetry consent, before their first load. */
export function isTelemetryOnlyProfile(profile: unknown): boolean {
  const settings = isRecord(profile) ? profile.settings : undefined
  return (
    isRecord(profile) &&
    Object.keys(profile).length === 1 &&
    isRecord(settings) &&
    Object.keys(settings).length === 1 &&
    isRecord(settings.telemetry)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
