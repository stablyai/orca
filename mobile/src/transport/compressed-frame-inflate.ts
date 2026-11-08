import { gunzipSync } from 'fflate'
import {
  inflateCompressedFrame,
  type CompressedFrameCodec,
  type InflatedFrame
} from '../../../src/shared/remote-runtime/e2ee/paired-e2ee-compressed-frame'
import { pairedE2EENativeCodec, type PairedE2EENativeCodec } from './paired-e2ee-native-codec'

const FFLATE_CODEC: CompressedFrameCodec = {
  gunzip: (gzipped, outputLimit) => gunzipSync(gzipped, { out: new Uint8Array(outputLimit) }),
  decodeUtf8: (bytes) => new TextDecoder().decode(bytes)
}

let nativeCodec: { native: PairedE2EENativeCodec; codec: CompressedFrameCodec } | null = null

function mobileCodec(): CompressedFrameCodec {
  const native = pairedE2EENativeCodec()
  if (!native) {
    return FFLATE_CODEC
  }
  if (nativeCodec?.native !== native) {
    nativeCodec = {
      native,
      codec: {
        gunzip: (gzipped, outputLimit) => native.gunzip(gzipped, outputLimit),
        decodeUtf8: (bytes) => native.decodeUtf8(bytes) ?? new TextDecoder().decode(bytes)
      }
    }
  }
  return nativeCodec.codec
}

/** What a compressed frame carries, or null for any other binary frame; throws on a corrupt one. */
export function inflateMobileCompressedFrame(frame: Uint8Array): InflatedFrame | null {
  return inflateCompressedFrame(frame, mobileCodec())
}
