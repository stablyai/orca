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
  fun `measures the cap in UTF-8 bytes, not characters`() {
    // A multi-byte payload must not buy extra room; the view measures the same way.
    val wide = "😀".repeat(4)
    assertEquals(8, wide.length)
    assertEquals(16, wide.toByteArray(Charsets.UTF_8).size)
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
    // CSP says frame-src 'none', but Chromium injects the object into every same-origin frame, so
    // the shell states the rule itself rather than inheriting it from a header C0.7 has to relax.
    assertFalse(frame(isMainFrame = false))
    // An ArrayBuffer message: getData() throws on one, and base64 in JSON is the only binary lane.
    assertFalse(frame(isStringMessage = false))
    assertFalse(frame(isMainFrame = false, isStringMessage = false))
    // The document the current props replaced, still alive and still same-origin, speaking for a
    // load the caller has already been told is `loading`.
    assertFalse(frame(hasCommittedDocument = false))
  }

  private fun frame(
    isMainFrame: Boolean = true,
    isStringMessage: Boolean = true,
    hasCommittedDocument: Boolean = true
  ) = acceptsMobileWebShellBridgeFrame(isMainFrame, isStringMessage, hasCommittedDocument)

  @Test
  fun `asks for the listener only when the bridge was asked for`() {
    // The floor is a feature query, never a version string. With the prop false the shell must
    // still load on a provider that could not have run the bridge at all.
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

  @Test
  fun `names the injected object the same thing on both platforms`() {
    // iOS installs a global of this name from its document-start script; a swap here is a page that
    // reaches one shell and not the other.
    assertEquals("orcaBridge", MOBILE_WEB_SHELL_BRIDGE_OBJECT)
  }
}
