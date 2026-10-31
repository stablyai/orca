import { requireOptionalNativeModule } from 'expo-modules-core'

export type OrcaGzipUtf8CodecModule = {
  // Inflate one gzip member with header/CRC32/length checks, rejecting trailing bytes; stop at outputLimit with remainder unread, and throw for other failures.
  gunzip(input: Uint8Array, outputLimit: number): Uint8Array
  /** Well-formed UTF-8 with no leading BOM, decoded; null otherwise. */
  decodeUtf8(input: Uint8Array): string | null
}

/** Null in a binary built before the module existed. */
export const OrcaGzipUtf8Codec =
  requireOptionalNativeModule<OrcaGzipUtf8CodecModule>('OrcaGzipUtf8Codec')
