package expo.modules.orcagziputf8codec

import java.io.ByteArrayInputStream
import java.io.IOException
import org.brotli.dec.BrotliInputStream

class BoundedBrotliException(message: String) : Exception(message)

/** Inflate one brotli stream into at most outputLimit bytes; callers pass one byte beyond the length they
 * accept and check the result's length and hash, so truncated or overlong input fails there. */
fun brotliDecompressBounded(input: ByteArray, outputLimit: Int): ByteArray {
  if (outputLimit <= 0 || input.isEmpty()) {
    throw BoundedBrotliException("nothing to inflate")
  }
  val output = ByteArray(outputLimit)
  var produced = 0
  try {
    BrotliInputStream(ByteArrayInputStream(input)).use { stream ->
      while (produced < outputLimit) {
        val count = stream.read(output, produced, outputLimit - produced)
        if (count < 0) {
          break
        }
        produced += count
      }
    }
  } catch (error: IOException) {
    throw BoundedBrotliException(error.message ?: "invalid brotli data")
  }
  return if (produced == outputLimit) output else output.copyOf(produced)
}
