import { parseExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { HOST_GROUP_ROUTE, type HostStackRouteTarget } from '../../navigation/host-stack-navigation'
import { botGroupIdOfRoomPaneKey } from '../../../../src/shared/bots/bot-group-room-pane-key'
import { mobileSessionRouteTarget } from '../../session/mobile-session-route'
import { mobileSessionAccessTarget } from '../../session/mobile-session-item-target'
import type { HostCredentialStatus } from '../../host-catalog/host-profile'

export type NotificationNavigationOptions = {
  knownHostIds?: ReadonlySet<string>
  credentialStatusByHostId?: ReadonlyMap<string, HostCredentialStatus>
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

// Host-only taps need no stack coordination; sessionTarget identifies deep workspace destinations.
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
  const paneKey = readNonEmptyString(record.paneKey)
  const groupId = botGroupIdOfRoomPaneKey(paneKey)
  // Accept only relayed servers; unknown execution hosts retain the paired desktop route.
  const executionHost = parseExecutionHostId(readNonEmptyString(record.executionHost))
  const accessRequestId = readNonEmptyString(record.accessRequestId)
  const credentialStatus = options.credentialStatusByHostId?.get(hostId)
  return {
    hostId,
    sessionTarget: groupId
      ? { name: HOST_GROUP_ROUTE, params: { hostId, groupId } }
      : worktreeId
        ? mobileSessionRouteTarget({
            hostId,
            worktreeId,
            paneKey: paneKey ?? undefined,
            // An access request's push opens its decision in the bot's panel.
            ...(accessRequestId ? { botItem: mobileSessionAccessTarget(accessRequestId) } : {}),
            ...(executionHost?.kind === 'runtime' ? { executionHost: executionHost.id } : {})
          })
        : null,
    ...(credentialStatus === 'missing'
      ? { credentialRecovery: 're-pair' as const }
      : credentialStatus === 'temporarily-unavailable'
        ? { credentialRecovery: 'retry' as const }
        : {})
  }
}
