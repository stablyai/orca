package expo.modules.orcamobilewebshell

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

}
