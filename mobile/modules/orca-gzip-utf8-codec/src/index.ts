import { requireOptionalNativeModule } from 'expo-modules-core'

export type OrcaGzipUtf8CodecModule = {
  /**
   * Inflates exactly one gzip member, checking its header, CRC32 and length, and refusing any byte
   * after it. Never produces more than `outputLimit` bytes: a body that reaches the limit comes
   * back at the limit with the rest unread. Throws on anything else.
   */
  gunzip(input: Uint8Array, outputLimit: number): Uint8Array
  /** Well-formed UTF-8 with no leading BOM, decoded; null otherwise. */
  decodeUtf8(input: Uint8Array): string | null
}

/** Null in a binary built before the module existed. */
export const OrcaGzipUtf8Codec =
  requireOptionalNativeModule<OrcaGzipUtf8CodecModule>('OrcaGzipUtf8Codec')
