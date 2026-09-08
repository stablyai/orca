package expo.modules.mobilewebshell

import android.content.pm.ApplicationInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test

private const val NON_DEBUGGABLE_FLAGS = ApplicationInfo.FLAG_ALLOW_BACKUP
private const val DEBUGGABLE_FLAGS =
  ApplicationInfo.FLAG_ALLOW_BACKUP or ApplicationInfo.FLAG_DEBUGGABLE

/**
 * Drives the one-argument overload the production call site uses, so the BuildConfig default
 * bindings are exercised rather than values the test supplies. Runs under both variants:
 * testDebugUnitTest covers BuildConfig.DEBUG, testReleaseUnitTest covers the shipped APK.
 */
class MobileWebInspectionBuildConfigTest {
  @Test
  fun `a non-debuggable build is uninspectable under the real build config`() {
    assertFalse(isMobileWebInspectionEnabled(NON_DEBUGGABLE_FLAGS))
  }

  @Test
  fun `a debuggable debug build is inspectable under the real build config`() {
    assumeTrue(BuildConfig.DEBUG)
    assertTrue(isMobileWebInspectionEnabled(DEBUGGABLE_FLAGS))
  }

  @Test
  fun `a release build is inspectable only when it was built with the opt-in`() {
    assumeFalse(BuildConfig.DEBUG)
    if (BuildConfig.ORCA_INSPECTABLE_RELEASE) {
      assertTrue(isMobileWebInspectionEnabled(DEBUGGABLE_FLAGS))
    } else {
      assertFalse(isMobileWebInspectionEnabled(DEBUGGABLE_FLAGS))
    }
  }
}
