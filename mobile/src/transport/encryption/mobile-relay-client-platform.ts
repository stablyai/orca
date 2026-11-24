import type { RelayClientPlatform } from '../../../../src/shared/remote-runtime/relay/client/relay-client-platform'
import { inflateMobileCompressedFrame } from './compressed-frame-inflate'
import { latchHostToE2EEV2 } from './e2ee-v2-host-latch'
import { MOBILE_PAIRED_E2EE_PRIMITIVES } from './mobile-paired-e2ee-primitives'
import { receiveBinaryAsBase64, websocketPayloadToUint8 } from './websocket-payload-bytes'

export const MOBILE_RELAY_CLIENT_PLATFORM: RelayClientPlatform = {
  primitives: MOBILE_PAIRED_E2EE_PRIMITIVES,
  createSocket: (url, events) => {
    const socket = receiveBinaryAsBase64(new WebSocket(url))
    socket.onopen = events.onOpen
    socket.onmessage = (event) => events.onMessage(event.data)
    socket.onerror = events.onError
    socket.onclose = (event) => events.onClose(event.code, event.reason ?? '')
    return socket
  },
  decodeBinary: websocketPayloadToUint8,
  inflateFrame: inflateMobileCompressedFrame,
  latchHostToE2EEV2
}
