// A paired computer has no environment here, so the conversations and question records this Orca's
// agents keep with one name its pairing instead: `client:<device id>/<installation id>`. Nothing that
// resolves an environment as a paired server may read these.

export const CLIENT_ENVIRONMENT_PREFIX = 'client:'

/** Keeps a paired computer's conversations out of every read that treats a home environment as a server. */
export const NOT_CLIENT_ENVIRONMENT_SQL = `environment_id NOT LIKE '${CLIENT_ENVIRONMENT_PREFIX}%'`

/** The installation as well as the device: several desktops can share one device row. */
export function clientEnvironmentId(deviceId: string, installationId: string): string {
  return `${CLIENT_ENVIRONMENT_PREFIX}${deviceId}/${installationId}`
}

export function isClientEnvironment(environmentId: string | null | undefined): boolean {
  return environmentId?.startsWith(CLIENT_ENVIRONMENT_PREFIX) === true
}

/** Every installation's environment under one device, for a LIKE match when the device goes. */
export function clientDeviceEnvironmentPattern(deviceId: string): string {
  const escaped = deviceId.replace(/[\\%_]/g, '\\$&')
  return `${CLIENT_ENVIRONMENT_PREFIX}${escaped}/%`
}

/** The device and installation a paired computer's environment names. */
export function clientEnvironmentParts(
  environmentId: string
): { deviceId: string; installationId: string } | null {
  if (!isClientEnvironment(environmentId)) {
    return null
  }
  const rest = environmentId.slice(CLIENT_ENVIRONMENT_PREFIX.length)
  const slash = rest.lastIndexOf('/')
  return slash <= 0
    ? null
    : { deviceId: rest.slice(0, slash), installationId: rest.slice(slash + 1) }
}
