import {
  clearWatermark,
  forgetHostNotificationSession
} from '../notifications/notification-reconnect-catchup'
import { removeHost } from './host-store'

export async function removeHostAndCloseClient(
  hostId: string,
  forgetHostClient: (hostId: string) => void
): Promise<void> {
  // Why: closing before the metadata commit can strand a still-paired host on
  // storage failure; closing immediately after success prevents socket leaks.
  await removeHost(hostId)
  forgetHostClient(hostId)
  // Why: the notification session outlives the socket by design (it must survive
  // reconnects), so removal is the only thing that can retire it. Left behind, a
  // re-pair of the same host would inherit a watermark for a counter it never saw.
  forgetHostNotificationSession(hostId)
  void clearWatermark(hostId)
}
