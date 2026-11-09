package expo.modules.orcagziputf8codec

import org.junit.Assert.assertNull
import org.junit.Test

class StrictUtf8Test {
  @Test
  fun `hands back to JS what TextDecoder would repair or strip`() {
    val refused = listOf(
      byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte(), 0x41),
      byteArrayOf(0xc0.toByte(), 0x80.toByte()),
      byteArrayOf(0xed.toByte(), 0xa0.toByte(), 0x80.toByte()),
      byteArrayOf(0x41, 0xe2.toByte(), 0x82.toByte()),
      byteArrayOf(0x80.toByte()),
      byteArrayOf(0xf5.toByte(), 0x80.toByte(), 0x80.toByte(), 0x80.toByte())
    )
    for (bytes in refused) {
      assertNull(decodeStrictUtf8(bytes))
    }
  }
}
