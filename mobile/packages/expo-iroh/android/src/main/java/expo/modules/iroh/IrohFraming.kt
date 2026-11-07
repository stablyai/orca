package expo.modules.iroh

internal object IrohFraming {
  // max(base64(4 MiB + 82), 8 MiB + 82); E2EEv2 adds 24 nonce + 16 MAC + 42 header bytes.
  const val MAX_PAYLOAD = 8 * 1024 * 1024 + 82

  /** Encode a bounded raw payload length as a four-byte big-endian header. */
  fun header(length: Int): ByteArray {
    require(length in 0..MAX_PAYLOAD) { "iroh_frame_too_large" }
    return byteArrayOf((length ushr 24).toByte(), (length ushr 16).toByte(), (length ushr 8).toByte(), length.toByte())
  }

  /** Decode exactly four header bytes, rejecting oversized lengths before payload allocation. */
  fun length(header: ByteArray): Int {
    require(header.size == 4) { "iroh_invalid_frame_header" }
    var length = 0
    for (byte in header) length = (length shl 8) or (byte.toInt() and 0xff)
    require(length in 0..MAX_PAYLOAD) { "iroh_frame_too_large" }
    return length
  }
}
