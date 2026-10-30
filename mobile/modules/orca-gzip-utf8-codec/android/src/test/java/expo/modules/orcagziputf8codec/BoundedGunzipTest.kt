package expo.modules.orcagziputf8codec

import java.io.File
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test

class BoundedGunzipTest {
  // Shared with the Swift checks and the JS tests, which pin fflate's answer to the same inputs.
  private val vectors = JSONArray(File("../tests/gunzip-vectors.json").readText())

  @Test
  fun `answers every shared vector as zlib's gzip mode does`() {
    for (index in 0 until vectors.length()) {
      val vector = vectors.getJSONObject(index)
      val expected = if (vector.isNull("native")) null else vector.getString("native")
      val actual = try {
        gunzipBounded(hexBytes(vector.getString("gzipHex")), vector.getInt("outputLimit")).toHex()
      } catch (_: BoundedGunzipException) {
        null
      }
      assertEquals(vector.getString("name"), expected, actual)
    }
  }

  private fun hexBytes(hex: String) =
    ByteArray(hex.length / 2) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }

  private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
}
