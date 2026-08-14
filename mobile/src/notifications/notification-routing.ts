import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'
import type { HostCredentialStatus } from '../transport/types'

export type DesktopNotificationSource = 'agent-task-complete' | 'terminal-bell' | 'test'

export type DesktopNotificationEvent = {
  source: DesktopNotificationSource
  worktreeId?: string
  notificationId?: string
}

export type LocalNotificationData = {
  source: DesktopNotificationSource
  hostId: string
  worktreeId?: string
  notificationId?: string
}

export type NotificationNavigationOptions = {
  knownHostIds?: ReadonlySet<string>
  credentialStatusByHostId?: ReadonlyMap<string, HostCredentialStatus>
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function buildLocalNotificationData(
  event: DesktopNotificationEvent,
  hostId: string
): LocalNotificationData {
  const data: LocalNotificationData = {
    source: event.source,
    hostId
  }
  if (event.worktreeId) {
    data.worktreeId = event.worktreeId
  }
  if (event.notificationId) {
    data.notificationId = event.notificationId
  }
  return data
}

/** Where a tap should land. `sessionTarget` is null for a host-only notification, whose
 *  `/h/<id>` push is shallow enough to need no host-stack coordination. */
export type NotificationNavigationTarget = Readonly<{
  hostId: string
  sessionTarget: HostStackRouteTarget | null
  credentialRecovery?: 'retry' | 're-pair'
}>

export function notificationCredentialRecoveryRoute(
  target: NotificationNavigationTarget
): '/' | '/pair-scan' | null {
  if (target.credentialRecovery === 're-pair') {
    return '/pair-scan'
  }
  return target.credentialRecovery === 'retry' ? '/' : null
}

export function getNotificationNavigationTarget(
  data: unknown,
  options: NotificationNavigationOptions = {}
): NotificationNavigationTarget | null {
  if (!data || typeof data !== 'object') {
    return null
  }

  const record = data as Record<string, unknown>
  const hostId = readNonEmptyString(record.hostId)
  if (!hostId) {
    return null
  }
  if (options.knownHostIds && !options.knownHostIds.has(hostId)) {
    return null
  }

  const worktreeId = readNonEmptyString(record.worktreeId)
  const credentialStatus = options.credentialStatusByHostId?.get(hostId)
  return {
    hostId,
    sessionTarget: worktreeId ? mobileSessionRouteTarget({ hostId, worktreeId }) : null,
    ...(credentialStatus === 'missing'
      ? { credentialRecovery: 're-pair' as const }
      : credentialStatus === 'temporarily-unavailable'
        ? { credentialRecovery: 'retry' as const }
        : {})
  }
}
