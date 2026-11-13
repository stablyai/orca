import { MOBILE_BRIDGE_MAX_FRAME_BYTES as BRIDGE_MAX_MESSAGE_BYTES } from '../../../../../src/shared/mobile-bridge-frame-bytes'
import { bridgeEventEnvelopeBytes } from '../../../mobile-web-shell/bridge/bridge-event-envelope-bytes'

// Budget serialized payload bytes after bridge-envelope overhead; ANSI escapes expand in JSON and raw snapshot sizes can overflow the shell’s hard frame cap.
export function mobileTerminalSnapshotByteBudget(): number | undefined {
  return BRIDGE_MAX_MESSAGE_BYTES - bridgeEventEnvelopeBytes()
}
