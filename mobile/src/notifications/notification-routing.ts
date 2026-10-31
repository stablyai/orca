import { parseExecutionHostId } from '../../../src/shared/execution-host'
import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'
import type { HostCredentialStatus } from '../transport/types'

export type NotificationNavigationOptions = {
  knownHostIds?: ReadonlySet<string>
  credentialStatusByHostId?: ReadonlyMap<string, HostCredentialStatus>
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

// Only sessionTarget carries a workspace destination; coarse taps retire any pending workspace.
export type NotificationNavigationTarget =
  | Readonly<{ home: true; hostId?: never; sessionTarget?: never; credentialRecovery?: never }>
  | Readonly<{
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
  if (record.home === true) {
    return { home: true }
  }
  const hostId = readNonEmptyString(record.hostId)
  if (!hostId) {
    return null
  }
  if (options.knownHostIds && !options.knownHostIds.has(hostId)) {
    return null
  }

  const worktreeId = readNonEmptyString(record.worktreeId)
  // Accept only relayed servers; unknown execution hosts retain the paired desktop route.
  const executionHost = parseExecutionHostId(readNonEmptyString(record.executionHost))
  const credentialStatus = options.credentialStatusByHostId?.get(hostId)
  return {
    hostId,
    sessionTarget: worktreeId
      ? mobileSessionRouteTarget({
          hostId,
          worktreeId,
          paneKey: readNonEmptyString(record.paneKey) ?? undefined,
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
