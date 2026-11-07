package expo.modules.iroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class IrohRelayUrlTest {
  @Test
  fun acceptsOnlyHttpsOriginsWithoutLeakingRejectedValues() {
    assertNull(IrohClient.parseHomeRelayUrl(null))
    assertNull(IrohClient.parseHomeRelayUrl(" \n "))
    assertEquals(
      "https://aps1-1.relay.n0.iroh.link./",
      IrohClient.parseHomeRelayUrl(" HTTPS://APS1-1.RELAY.N0.IROH.LINK.:443/ ")
    )
    assertEquals("https://relay.example:8443/", IrohClient.parseHomeRelayUrl("https://relay.example:8443"))
    assertEquals("https://[::1]:8443/", IrohClient.parseHomeRelayUrl("https://[::1]:8443/"))
    for (value in listOf(
      "http://relay.example/", "https:relay.example", "https:///relay.example/",
      "https://user:secret@relay.example/", "https://relay.example/path",
      "https://relay.example/?token=secret", "https://relay.example/#secret",
      "https://relay.example:/", "https://relay.example:0/", "https://relay.example:65536/",
      "https://relay.example:invalid/", "https://relay.example\\secret/",
      "https://relay. example/", "https://[fe80::1%25wlan0]/"
    )) {
      val error = assertThrows(IllegalArgumentException::class.java) { IrohClient.parseHomeRelayUrl(value) }
      assertEquals("iroh_invalid_relay_url", error.message)
      assertNull(error.cause)
    }
  }
}
