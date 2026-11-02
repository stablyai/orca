export type LegacyNotificationOptInParams = {
  hostId?: string | string[]
}

export type LegacyNotificationOptInDestination = {
  pathname: '/mobile-onboarding'
  params: { steps: 'notifications'; hostId?: string }
}

export function legacyNotificationOptInDestination(
  params: LegacyNotificationOptInParams
): LegacyNotificationOptInDestination {
  const hostId = Array.isArray(params.hostId) ? params.hostId[0] : params.hostId
  return {
    pathname: '/mobile-onboarding',
    params: { steps: 'notifications', ...(hostId ? { hostId } : {}) }
  }
}
