package expo.modules.orcamobilewebshell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebShellBridgeTest {
  @Test
  fun `hears only a string message from the main frame of a committed document`() {
    assertTrue(frame())
    // Chromium injects into same-origin subframes; enforce main-frame independently of CSP.
    assertFalse(frame(isMainFrame = false))
    // An ArrayBuffer message: getData() throws on one, and base64 in JSON is the only binary lane.
    assertFalse(frame(isStringMessage = false))
    assertFalse(frame(isMainFrame = false, isStringMessage = false))
    // The replaced same-origin document remains alive until the new load commits.
    assertFalse(frame(hasCommittedDocument = false))
  }

  private fun frame(
    isMainFrame: Boolean = true,
    isStringMessage: Boolean = true,
    hasCommittedDocument: Boolean = true
  ) = acceptsMobileWebShellBridgeFrame(isMainFrame, isStringMessage, hasCommittedDocument)

}
