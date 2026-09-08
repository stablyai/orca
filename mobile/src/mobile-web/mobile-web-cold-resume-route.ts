import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'orca:mobile-web-cold-resume-route:v1'
const IDENTITY_MAX_CHARACTERS = 512
const STORAGE_MAX_CHARACTERS = 2 * 1024

export type MobileWebColdResumeRoute = {
  hostIdentity: string
  hostWorkspaceIdentity: string
}

export function mobileWebColdResumeStartupPath(
  route: MobileWebColdResumeRoute | null,
  hosts: readonly { id: string }[],
  pathname: string,
  nativeBaselineEnabled = false
): `/hybrid?hostId=${string}` | null {
  return !nativeBaselineEnabled &&
    route &&
    pathname === '/' &&
    hosts.some((host) => host.id === route.hostIdentity)
    ? `/hybrid?hostId=${encodeURIComponent(route.hostIdentity)}`
    : null
}

let routeMutation: Promise<void> = Promise.resolve()

export async function loadMobileWebColdResumeRoute(): Promise<MobileWebColdResumeRoute | null> {
  await routeMutation
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    return parseMobileWebColdResumeRoute(raw)
  } catch {
    return null
  }
}

export function saveMobileWebColdResumeRoute(route: MobileWebColdResumeRoute): Promise<void> {
  const parsed = parseMobileWebColdResumeRoute(
    JSON.stringify({
      version: 1,
      hostIdentity: route.hostIdentity,
      hostWorkspaceIdentity: route.hostWorkspaceIdentity
    })
  )
  if (!parsed) {
    return Promise.reject(new Error('mobile_web_cold_resume_route_invalid'))
  }
  return mutateRoute(() =>
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        hostIdentity: parsed.hostIdentity,
        hostWorkspaceIdentity: parsed.hostWorkspaceIdentity
      })
    )
  )
}

export function clearMobileWebColdResumeRoute(): Promise<void> {
  return mutateRoute(() => AsyncStorage.removeItem(STORAGE_KEY))
}

export function clearMobileWebColdResumeRouteForHost(hostIdentity: string): Promise<void> {
  return mutateRoute(async () => {
    const route = parseMobileWebColdResumeRoute(await AsyncStorage.getItem(STORAGE_KEY))
    if (route?.hostIdentity === hostIdentity) {
      await AsyncStorage.removeItem(STORAGE_KEY)
    }
  })
}

function mutateRoute(mutation: () => Promise<void>): Promise<void> {
  const next = routeMutation.then(mutation)
  routeMutation = next.catch(() => {})
  return next
}

function parseMobileWebColdResumeRoute(raw: string | null): MobileWebColdResumeRoute | null {
  if (!raw || raw.length > STORAGE_MAX_CHARACTERS) {
    return null
  }
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value) || value.version !== 1) {
      return null
    }
    const hostIdentity = boundedIdentity(value.hostIdentity)
    const hostWorkspaceIdentity = boundedIdentity(value.hostWorkspaceIdentity)
    return hostIdentity && hostWorkspaceIdentity ? { hostIdentity, hostWorkspaceIdentity } : null
  } catch {
    return null
  }
}

function boundedIdentity(value: unknown): string | null {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= IDENTITY_MAX_CHARACTERS
    ? value
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
