import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import { refreshCurrentOrcaProfileAuth } from '../../orca-profiles/profile-cloud-capability-refresh'
import { ensureActiveOrcaProfile } from '../../orca-profiles/profile-index-store'
import { readFreshOrcaCloudSession } from '../../orca-profiles/profile-cloud-session-refresh'
import type { RelayAuthContext } from './relay-auth-coordinator'

const RELAY_CAPABILITY_REFRESH_COOLDOWN_MS = 60_000
const relayCapabilityRefreshes = new Map<string, Promise<void>>()
const relayCapabilityRefreshCooldowns = new Map<
  string,
  { expiresAt: number; timer: ReturnType<typeof setTimeout> }
>()

function startRelayCapabilityRefreshCooldown(key: string): void {
  const previous = relayCapabilityRefreshCooldowns.get(key)
  if (previous) {
    clearTimeout(previous.timer)
  }
  const expiresAt = Date.now() + RELAY_CAPABILITY_REFRESH_COOLDOWN_MS
  const timer = setTimeout(() => {
    if (relayCapabilityRefreshCooldowns.get(key)?.expiresAt === expiresAt) {
      relayCapabilityRefreshCooldowns.delete(key)
    }
  }, RELAY_CAPABILITY_REFRESH_COOLDOWN_MS)
  timer.unref()
  relayCapabilityRefreshCooldowns.set(key, { expiresAt, timer })
}

export function resetRelayCapabilityRefreshStateForTests(): void {
  relayCapabilityRefreshes.clear()
  for (const cooldown of relayCapabilityRefreshCooldowns.values()) {
    clearTimeout(cooldown.timer)
  }
  relayCapabilityRefreshCooldowns.clear()
}

async function refreshInactiveRelayCapability(
  profileId: string,
  userDataPath: string
): Promise<boolean> {
  const key = `${userDataPath}\0${profileId}`
  const existing = relayCapabilityRefreshes.get(key)
  if (existing) {
    await existing
    return true
  }
  if ((relayCapabilityRefreshCooldowns.get(key)?.expiresAt ?? 0) > Date.now()) {
    return false
  }

  startRelayCapabilityRefreshCooldown(key)
  const refresh = Promise.resolve()
    .then(() => refreshCurrentOrcaProfileAuth(userDataPath))
    .then(() => undefined)
    .finally(() => {
      relayCapabilityRefreshes.delete(key)
    })
  relayCapabilityRefreshes.set(key, refresh)
  await refresh
  return true
}

export async function readRelayAuthContext(
  authConfig: OrcaCloudAuthConfig,
  userDataPath: string
): Promise<RelayAuthContext | null> {
  let active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return null
  }
  let sessionResult = await readFreshOrcaCloudSession(authConfig, active, userDataPath)
  if (sessionResult.status !== 'found') {
    return null
  }
  // Why: capability flags outlive access-token freshness and can stay false
  // after Relay is enabled server-side. Refresh before gating the broker.
  if (
    sessionResult.session.capabilities.flags['relay.use'] !== true &&
    (await refreshInactiveRelayCapability(active.profile.id, userDataPath))
  ) {
    active = ensureActiveOrcaProfile(userDataPath)
    if (!active.profile.cloud) {
      return null
    }
    sessionResult = await readFreshOrcaCloudSession(authConfig, active, userDataPath)
    if (sessionResult.status !== 'found') {
      return null
    }
  }
  // Why: refresh and org-selection can rewrite cloud linkage while the request
  // is in flight; identity must come from the post-refresh profile state.
  const refreshed = ensureActiveOrcaProfile(userDataPath)
  const cloud = refreshed.profile.cloud
  if (!cloud || refreshed.profile.id !== active.profile.id) {
    return null
  }
  return {
    identity: {
      userId: cloud.userId,
      profileId: cloud.cloudProfileId,
      organizationId: cloud.activeOrgId ?? ''
    },
    accessToken: sessionResult.session.accessToken,
    relayEntitled: sessionResult.session.capabilities.flags['relay.use'] === true
  }
}
