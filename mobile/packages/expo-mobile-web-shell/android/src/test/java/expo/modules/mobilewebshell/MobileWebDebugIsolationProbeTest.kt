package expo.modules.mobilewebshell

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebDebugIsolationProbeTest {
  @Test
  fun `builds the loopback isolation corpus for valid launch extras`() {
    val script = createMobileWebDebugIsolationProbeScript(
      "41321",
      "EA34F98A-0FD4-44A8-8C8C-C3A40D307B7A"
    )

    assertNotNull(script)
    assertTrue(requireNotNull(script).contains("http://127.0.0.1:41321"))
    assertTrue(script.contains("ws://127.0.0.1:41321"))
    assertTrue(script.contains("globalThis.__orcaMobileWebShellListening!==true"))
    assertTrue(script.contains("completed===4"))
    assertTrue(script.contains("__orcaDebugNavigationProbeCompletion"))
    assertTrue(script.contains("__orcaDebugExecutableProbeCompletion"))
    assertTrue(script.contains("activeDeclaredScriptLoaded"))
    assertTrue(script.contains("undeclaredScriptBlocked"))
    assertTrue(script.contains("[a-f0-9]{64}\\.js$"))
    assertTrue(script.contains("script.getAttribute('src')"))
    assertTrue(script.contains("new URL(declaredScriptPath(activeScript),location.origin)"))
    assertTrue(script.contains("window.open(probeBase+'/popup-probe','_blank')"))
    assertTrue(script.contains("navigator.serviceWorker.register(probeBase+'/worker-probe')"))
    assertTrue(script.contains("location.assign('orca-security-probe://blocked')"))
    assertTrue(script.contains("String(location.origin)===originalOrigin"))
    assertTrue(script.contains("String(location.hash)===originalSession"))
  }

  @Test
  fun `rejects absent malformed and out of range launch extras`() {
    assertNull(createMobileWebDebugIsolationProbeScript(null, null))
    assertNull(
      createMobileWebDebugIsolationProbeScript(
        "0",
        "EA34F98A-0FD4-44A8-8C8C-C3A40D307B7A"
      )
    )
    assertNull(
      createMobileWebDebugIsolationProbeScript(
        "65536",
        "EA34F98A-0FD4-44A8-8C8C-C3A40D307B7A"
      )
    )
    assertNull(createMobileWebDebugIsolationProbeScript("41321", "not-a-uuid"))
  }
}
