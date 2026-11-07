package expo.modules.iroh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class IrohFramingTest {
  @Test
  fun boundedNetworkOrderFrames() {
    assertArrayEquals(byteArrayOf(0, 1, 0, 0), IrohFraming.header(65_536))
    assertArrayEquals(byteArrayOf(0, -128, 0, 82), IrohFraming.header(8_388_690))
    assertEquals(8_388_690, IrohFraming.length(byteArrayOf(0, -128, 0, 82)))
    for (length in listOf(0, 1, 65_536, 8_388_690)) {
      assertEquals(length, IrohFraming.length(IrohFraming.header(length)))
    }
    for (header in listOf(byteArrayOf(0, -128, 0, 83), byteArrayOf(-1, -1, -1, -1), byteArrayOf(0))) {
      assertThrows(IllegalArgumentException::class.java) { IrohFraming.length(header) }
    }
    assertThrows(IllegalArgumentException::class.java) { IrohFraming.header(8_388_691) }
  }
}
