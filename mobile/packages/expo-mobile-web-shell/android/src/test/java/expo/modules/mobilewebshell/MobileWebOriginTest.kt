package expo.modules.mobilewebshell

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Session ids are base64url, which no URL host can carry: `https` is a special scheme, so Chromium
 * ASCII-lowercases the host of every URL it loads and reports back, and `java.net.URI.getHost()` is
 * null for a label holding `_`. A sliced label therefore lost the document (403) and the bridge
 * (dropped messages), so the origin label is hashed instead.
 */
class MobileWebOriginTest {
  private val sessionIds = listOf(
    "47Im-Tb2_rq2Y5jz235dEGMcvyQSk5p17H5-UZaA-Pc",
    "S5i5IfxeTICYxGmyVxhTvzKTWWBO5O7H5-UZaA-Pc0w",
    "_".repeat(43),
    "A".repeat(43)
  )

  @Test
  fun `derives a host every URL parser leaves untouched`() {
    for (sessionId in sessionIds) {
      val host = mobileWebOriginHostForSession(sessionId)

      assertEquals(sessionId, host, host.lowercase())
      assertEquals(sessionId, host, URI(mobileWebOriginForSession(sessionId)).host)
      assertTrue(sessionId, isMobileWebOriginHostForSession(URI("https://$host/").host, sessionId))
      assertTrue(
        sessionId,
        isAllowedMobileWebBridgeDocumentUrl(
          "${mobileWebOriginForSession(sessionId)}/#$sessionId",
          sessionId
        )
      )
    }
  }

  @Test
  fun `keeps distinct sessions on distinct origins`() {
    val origins = sessionIds.map(::mobileWebOriginForSession)

    assertEquals(sessionIds.size, origins.toSet().size)
    assertFalse(isMobileWebOriginHostForSession(mobileWebOriginHostForSession(sessionIds[1]), sessionIds[0]))
  }

  @Test
  fun `rejects session ids outside the bridge token charset`() {
    for (sessionId in listOf("", "has space", "has.dot", "a".repeat(129))) {
      assertEquals(
        sessionId,
        "mobile_web_session_id_invalid",
        runCatching { mobileWebOriginForSession(sessionId) }.exceptionOrNull()?.message
      )
    }
  }
}
