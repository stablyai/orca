package expo.modules.orcagziputf8codec

import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

class BoundedGunzipException(message: String) : Exception(message)

private const val FLAG_HCRC = 0x02
private const val FLAG_EXTRA = 0x04
private const val FLAG_NAME = 0x08
private const val FLAG_COMMENT = 0x10
private const val FLAG_RESERVED = 0xe0
private const val TRAILER_LENGTH = 8

/**
 * Inflates exactly one gzip member, as zlib's gzip mode does on iOS: the header, CRC32 and ISIZE
 * are checked, and any byte after the member (trailing data or a second member) is refused.
 *
 * Never produces more than [outputLimit] bytes. A body that reaches the limit comes back at the
 * limit with the rest of the stream unread: the caller sets the limit one past anything it accepts.
 */
fun gunzipBounded(input: ByteArray, outputLimit: Int): ByteArray {
  if (outputLimit < 0) {
    throw BoundedGunzipException("negative output limit")
  }
  val bodyStart = gzipBodyStart(input)
  val output = ByteArray(outputLimit)
  val inflater = Inflater(true)
  try {
    inflater.setInput(input, bodyStart, input.size - bodyStart)
    var produced = 0
    while (!inflater.finished()) {
      if (produced == outputLimit) {
        return output
      }
      val count = try {
        inflater.inflate(output, produced, outputLimit - produced)
      } catch (error: DataFormatException) {
        throw BoundedGunzipException(error.message ?: "invalid deflate data")
      }
      if (count == 0 && inflater.needsInput()) {
        throw BoundedGunzipException("truncated deflate data")
      }
      produced += count
    }
    val trailerStart = input.size - inflater.remaining
    if (inflater.remaining < TRAILER_LENGTH) {
      throw BoundedGunzipException("truncated gzip trailer")
    }
    if (inflater.remaining > TRAILER_LENGTH) {
      throw BoundedGunzipException("data after the gzip member")
    }
    val crc = CRC32().apply { update(output, 0, produced) }.value
    if (readUint32(input, trailerStart) != crc) {
      throw BoundedGunzipException("gzip CRC mismatch")
    }
    if (readUint32(input, trailerStart + 4) != produced.toLong()) {
      throw BoundedGunzipException("gzip length mismatch")
    }
    return if (produced == outputLimit) output else output.copyOf(produced)
  } finally {
    inflater.end()
  }
}

/** RFC 1952 header, checked as strictly as zlib checks it: reserved flags and FHCRC included. */
private fun gzipBodyStart(input: ByteArray): Int {
  fun byteAt(index: Int): Int {
    if (index >= input.size) {
      throw BoundedGunzipException("truncated gzip header")
    }
    return input[index].toInt() and 0xff
  }
  if (byteAt(0) != 0x1f || byteAt(1) != 0x8b) {
    throw BoundedGunzipException("not gzip")
  }
  if (byteAt(2) != 8) {
    throw BoundedGunzipException("unknown gzip compression method")
  }
  val flags = byteAt(3)
  if (flags and FLAG_RESERVED != 0) {
    throw BoundedGunzipException("reserved gzip flags set")
  }
  // MTIME, XFL and OS are not read, but a header without them is truncated.
  byteAt(9)
  var cursor = 10
  if (flags and FLAG_EXTRA != 0) {
    cursor += 2 + (byteAt(cursor) or (byteAt(cursor + 1) shl 8))
  }
  if (flags and FLAG_NAME != 0) {
    while (byteAt(cursor++) != 0) {}
  }
  if (flags and FLAG_COMMENT != 0) {
    while (byteAt(cursor++) != 0) {}
  }
  if (flags and FLAG_HCRC != 0) {
    val expected = byteAt(cursor) or (byteAt(cursor + 1) shl 8)
    val crc = CRC32().apply { update(input, 0, cursor) }.value and 0xffff
    if (crc != expected.toLong()) {
      throw BoundedGunzipException("gzip header CRC mismatch")
    }
    cursor += 2
  }
  return cursor
}

private fun readUint32(input: ByteArray, offset: Int): Long =
  (0 until 4).fold(0L) { value, index ->
    value or ((input[offset + index].toLong() and 0xff) shl (8 * index))
  }
