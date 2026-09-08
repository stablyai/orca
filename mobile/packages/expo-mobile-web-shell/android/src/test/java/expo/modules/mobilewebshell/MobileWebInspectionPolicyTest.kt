package expo.modules.mobilewebshell

import android.content.pm.ApplicationInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NON_DEBUGGABLE_FLAGS = ApplicationInfo.FLAG_ALLOW_BACKUP
private const val DEBUGGABLE_FLAGS =
  ApplicationInfo.FLAG_ALLOW_BACKUP or ApplicationInfo.FLAG_DEBUGGABLE

class MobileWebInspectionPolicyTest {
  @Test
  fun `keeps a production release uninspectable however it was built`() {
    for (isInspectableRelease in listOf(false, true)) {
      assertFalse(
        isMobileWebInspectionEnabled(
          NON_DEBUGGABLE_FLAGS,
          isDebugBuild = false,
          isInspectableRelease = isInspectableRelease
        )
      )
    }
    assertFalse(
      isMobileWebInspectionEnabled(
        NON_DEBUGGABLE_FLAGS,
        isDebugBuild = true,
        isInspectableRelease = false
      )
    )
  }

  @Test
  fun `enables devtools only for a debuggable debug or opted-in release build`() {
    assertFalse(
      isMobileWebInspectionEnabled(
        DEBUGGABLE_FLAGS,
        isDebugBuild = false,
        isInspectableRelease = false
      )
    )
    assertTrue(
      isMobileWebInspectionEnabled(
        DEBUGGABLE_FLAGS,
        isDebugBuild = true,
        isInspectableRelease = false
      )
    )
    assertTrue(
      isMobileWebInspectionEnabled(
        DEBUGGABLE_FLAGS,
        isDebugBuild = false,
        isInspectableRelease = true
      )
    )
  }
}
