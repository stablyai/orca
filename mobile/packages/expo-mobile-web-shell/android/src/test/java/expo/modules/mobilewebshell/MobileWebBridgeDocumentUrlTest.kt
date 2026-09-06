package expo.modules.mobilewebshell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebBridgeDocumentUrlTest {
  private val sessionId = "S5i5IfxeTICYxGmyVxhTvzKTWWBO5O7H5-UZaA-Pc0"
  private val origin = mobileWebOriginForSession(sessionId)

  @Test
  fun `accepts session-bound client routes`() {
    assertTrue(
      isAllowedMobileWebBridgeDocumentUrl(
        "$origin/#$sessionId",
        sessionId
      )
    )
    assertTrue(
      isAllowedMobileWebBridgeDocumentUrl(
        "$origin/h/paired-orca-desktop/tasks#$sessionId",
        sessionId
      )
    )
    assertTrue(
      isAllowedMobileWebBridgeDocumentUrl(
        "$origin/h/paired-orca-desktop/session/workspace" +
          "?name=Feature+One#$sessionId",
        sessionId
      )
    )
  }

  @Test
  fun `rejects documents outside the active origin and session`() {
    val rejected = listOf(
      "http://${origin.removePrefix("https://")}/#$sessionId",
      "https://user@${origin.removePrefix("https://")}/#$sessionId",
      "$origin:443/#$sessionId",
      "https://orca-mobile-web.invalid.evil.test/#$sessionId",
      "$origin/",
      "${mobileWebOriginForSession("T".repeat(43))}/#$sessionId",
      "$origin/${"a".repeat(8 * 1024)}#$sessionId",
      "not a url"
    )

    for (value in rejected) {
      assertFalse(value, isAllowedMobileWebBridgeDocumentUrl(value, sessionId))
    }
  }
}
