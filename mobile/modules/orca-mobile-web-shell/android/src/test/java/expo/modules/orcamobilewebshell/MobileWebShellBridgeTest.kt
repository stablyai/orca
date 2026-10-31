package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebShellBridgeTest {
  @Test
  fun `caps a message at 640 KiB of raw bytes`() {
    val cap = MOBILE_WEB_SHELL_BRIDGE_MAX_MESSAGE_BYTES
    assertEquals(640 * 1024, cap)
    assertTrue(acceptsMobileWebShellBridgeByteCount(0))
    assertTrue(acceptsMobileWebShellBridgeByteCount(cap - 1))
    assertTrue(acceptsMobileWebShellBridgeByteCount(cap))
    assertFalse(acceptsMobileWebShellBridgeByteCount(cap + 1))
  }

  @Test
  fun `counts every refusal and lets nothing under the cap through uncounted`() {
    val cap = MOBILE_WEB_SHELL_BRIDGE_MAX_MESSAGE_BYTES
    val gate = MobileWebShellBridgeGate()
    assertEquals(0, gate.refusedCount)
    assertTrue(gate.accepts(cap))
    assertEquals(0, gate.refusedCount)
    assertFalse(gate.accepts(cap + 1))
    assertFalse(gate.accepts(cap * 2))
    assertEquals(2, gate.refusedCount)
  }

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

  @Test
  fun `asks for the listener only when the bridge was asked for`() {
    // Disabled bridges must load even without listener capability; query features, not versions.
    assertEquals(
      MobileWebShellBridgeInstall.SKIP,
      mobileWebShellBridgeInstall(bridgeEnabled = false, isListenerSupported = false)
    )
    assertEquals(
      MobileWebShellBridgeInstall.SKIP,
      mobileWebShellBridgeInstall(bridgeEnabled = false, isListenerSupported = true)
    )
    assertEquals(
      MobileWebShellBridgeInstall.INSTALL,
      mobileWebShellBridgeInstall(bridgeEnabled = true, isListenerSupported = true)
    )
    assertEquals(
      MobileWebShellBridgeInstall.UNAVAILABLE,
      mobileWebShellBridgeInstall(bridgeEnabled = true, isListenerSupported = false)
    )
  }

}
