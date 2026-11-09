package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebShellPoolTest {
  private fun props(
    generationDirectory: String = "/gen/aa",
    sessionId: String = "sess-01JN_aZ9",
    bridgeEnabled: Boolean = true
  ) = MobileWebShellAppliedProps(generationDirectory, sessionId, bridgeEnabled)

  @Test
  fun `reuses the retained slot when the applied triple matches`() {
    val evicted = mutableListOf<String>()
    val pool = MobileWebShellSlotPool<String> { evicted.add(it) }
    val slot = "webview-host-a"

    pool.retain(props(), slot)
    assertTrue(pool.hasRetained())

    val taken = pool.takeMatchingOrEvict(props())
    assertSame(slot, taken)
    assertFalse(pool.hasRetained())
    assertTrue(evicted.isEmpty())
  }

  @Test
  fun `evicts the retained slot when a different session or generation is requested`() {
    val evicted = mutableListOf<String>()
    val pool = MobileWebShellSlotPool<String> { evicted.add(it) }

    pool.retain(props(sessionId = "sess-host-a"), "webview-host-a")
    val taken = pool.takeMatchingOrEvict(props(sessionId = "sess-host-b"))

    assertNull(taken)
    assertFalse(pool.hasRetained())
    assertEquals(listOf("webview-host-a"), evicted)
  }

  @Test
  fun `evicts the older slot when a newer slot is retained`() {
    val evicted = mutableListOf<String>()
    val pool = MobileWebShellSlotPool<String> { evicted.add(it) }

    pool.retain(props(sessionId = "sess-host-a"), "webview-host-a")
    pool.retain(props(sessionId = "sess-host-b"), "webview-host-b")

    assertEquals(listOf("webview-host-a"), evicted)
    assertSame("webview-host-b", pool.takeMatchingOrEvict(props(sessionId = "sess-host-b")))
  }
}
