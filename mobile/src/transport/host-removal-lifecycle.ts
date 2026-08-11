import { retireHostNotificationState } from '../notifications/notification-reconnect-catchup'
import { connectionLogStore } from './connection-log-buffer'
import { removeHost } from './host-store'

export async function removeHostAndCloseClient(
  hostId: string,
  closeHostClient: (hostId: string) => void
): Promise<void> {
  // Why: closing before the metadata commit can strand a still-paired host on
  // storage failure; closing immediately after success prevents socket leaks.
  await removeHost(hostId)
  closeHostClient(hostId)
  connectionLogStore.clear(hostId)
  // Why: the notification session outlives the socket by design (it must survive
  // reconnects), so removal is the only thing that can retire it. Left behind, a
  // re-pair of the same host would inherit a watermark for a counter it never saw.
  await retireHostNotificationState(hostId)
}
