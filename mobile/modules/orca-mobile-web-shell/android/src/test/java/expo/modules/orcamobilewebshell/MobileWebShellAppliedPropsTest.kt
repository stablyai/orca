package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebShellAppliedPropsTest {
  private fun props(
    generationDirectory: String = "/gen/aa",
    sessionId: String = "sess-01JN_aZ9",
    bridgeEnabled: Boolean = true
  ) = MobileWebShellAppliedProps(generationDirectory, sessionId, bridgeEnabled)

  @Test
  fun `the same triple does not re-enter`() {
    assertTrue(props().matches(props()))
  }

  @Test
  fun `every field re-enters on its own`() {
    assertFalse(props().matches(props(generationDirectory = "/gen/ab")))
    assertFalse(props().matches(props(sessionId = "sess-01JN_aZ8")))
    assertFalse(props().matches(props(bridgeEnabled = false)))
  }

  @Test
  fun `compares every stored field`() {
    // A fourth prop that nobody compared is a prop that silently never reloads, so the record's
    // shape is pinned here rather than left to whoever adds the field.
    val fields = MobileWebShellAppliedProps::class.java.declaredFields
      .filterNot { it.isSynthetic }
      .map { it.name }
      .sorted()
    assertEquals(listOf("bridgeEnabled", "generationDirectory", "sessionId"), fields)
  }

  @Test
  fun `a triple that failed to apply is still applied`() {
    // The prop pair that could not install the listener is compared like any other: the caller sees
    // isolation-unavailable once, not on every commit for the life of the mount.
    val failed = props(generationDirectory = "/gen/corrupt")
    assertTrue(failed.matches(props(generationDirectory = "/gen/corrupt")))
  }
}
