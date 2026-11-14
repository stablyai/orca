// Mirrors the telemetry client's build gate without importing the client; names differ so bundle checks keep matching the client's constants.
const releaseIdentity: 'stable' | 'rc' | null =
  typeof ORCA_BUILD_IDENTITY !== 'undefined'
    ? ORCA_BUILD_IDENTITY
    : ((globalThis as { ORCA_BUILD_IDENTITY?: 'stable' | 'rc' | null }).ORCA_BUILD_IDENTITY ?? null)
const releaseWriteKey: string | null =
  typeof ORCA_POSTHOG_WRITE_KEY !== 'undefined'
    ? ORCA_POSTHOG_WRITE_KEY
    : ((globalThis as { ORCA_POSTHOG_WRITE_KEY?: string | null }).ORCA_POSTHOG_WRITE_KEY ?? null)

/** True only for CI-built stable/rc releases that can transmit telemetry. */
export function isOfficialTelemetryBuild(): boolean {
  return (
    (releaseIdentity === 'stable' || releaseIdentity === 'rc') &&
    typeof releaseWriteKey === 'string' &&
    releaseWriteKey.length > 0
  )
}
