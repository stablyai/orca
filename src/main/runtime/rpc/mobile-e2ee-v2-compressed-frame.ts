import { gzipSync } from 'node:zlib'
import {
  COMPRESSED_FRAMES_CLIENT_CAPABILITY,
  COMPRESSED_FRAME_MIN_BYTES,
  encodeCompressedFrame
} from '../../../shared/paired-e2ee-compressed-frame'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { DesktopMobileE2EEV2OutboundItem } from './mobile-e2ee-v2-desktop-outbound'
import type { RpcBinarySendOptions } from './rpc-binary-sender'

/** Gzips large text, and binary its sender marked compressible, for phones that read compressed frames. */
export function compressMobileE2EEV2Item(
  item: DesktopMobileE2EEV2OutboundItem,
  clientCapabilities: readonly RuntimeCapability[],
  options?: RpcBinarySendOptions
): DesktopMobileE2EEV2OutboundItem {
  // Why: screencast JPEGs never shrink, so binary is gzipped only when its sender knows it is text-like.
  const eligible = item.kind === 'text' || options?.compressible === true
  if (
    !eligible ||
    // Field rollback without a release: phones then read plain frames, as from older hosts.
    process.env.ORCA_DISABLE_MOBILE_COMPRESSED_FRAMES === '1' ||
    item.plaintext.length < COMPRESSED_FRAME_MIN_BYTES ||
    !clientCapabilities.includes(COMPRESSED_FRAMES_CLIENT_CAPABILITY)
  ) {
    return item
  }
  const payload = item.kind === 'text' ? Buffer.from(item.plaintext, 'utf8') : item.plaintext
  // Why: terminal binary streams continuously on the main thread; level 1 keeps ~95% of the saving at 2-4x less CPU.
  const gzipped = gzipSync(payload, item.kind === 'binary' ? { level: 1 } : undefined)
  // Why: already-dense payloads can grow under gzip; the plain frame then costs less.
  if (gzipped.byteLength >= payload.byteLength) {
    return item
  }
  return {
    kind: 'binary',
    plaintext: encodeCompressedFrame({
      payloadKind: item.kind,
      inflatedByteLength: payload.byteLength,
      gzipped
    })
  }
}
