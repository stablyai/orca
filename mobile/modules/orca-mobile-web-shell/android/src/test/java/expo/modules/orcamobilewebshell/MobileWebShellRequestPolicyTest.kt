package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val POLICY_SESSION = "sess-01JN_aZ9"
private val POLICY_HOST = mobileWebShellOriginHost(POLICY_SESSION)!!

private fun navigation(
  path: String?,
  host: String? = POLICY_HOST,
  scheme: String? = "https",
  query: String? = null
) = MobileWebShellRequestParts(
  method = "GET",
  hasRangeHeader = false,
  scheme = scheme,
  host = host,
  port = -1,
  userInfo = null,
  query = query,
  fragment = null,
  encodedPath = path,
  urlLength = 64
)

class MobileWebShellRequestPolicyTest {
  @Test
  fun `lets the document of the served generation load`() {
    assertFalse(mobileWebShellDropsNavigation(navigation("/"), POLICY_HOST, true))
    assertFalse(mobileWebShellDropsNavigation(navigation(""), POLICY_HOST, true))
  }

  @Test
  fun `drops everything else, so nothing the page builds can navigate`() {
    // A subresource path is servable but is not a document; a link out is neither.
    assertTrue(mobileWebShellDropsNavigation(navigation("/assets/aa.js"), POLICY_HOST, true))
    assertTrue(mobileWebShellDropsNavigation(navigation("/", query = "v=1"), POLICY_HOST, true))
    assertTrue(mobileWebShellDropsNavigation(navigation("/", host = "example.com"), POLICY_HOST, true))
    assertTrue(mobileWebShellDropsNavigation(navigation("/", scheme = "http"), POLICY_HOST, true))
    assertTrue(mobileWebShellDropsNavigation(navigation("/", scheme = "file"), POLICY_HOST, true))
    assertTrue(mobileWebShellDropsNavigation(navigation("/", scheme = "intent"), POLICY_HOST, true))
    assertTrue(mobileWebShellDropsNavigation(navigation(null), POLICY_HOST, true))
  }

  @Test
  fun `drops a subframe navigation and any navigation before a generation is served`() {
    assertTrue(mobileWebShellDropsNavigation(navigation("/"), POLICY_HOST, false))
    assertTrue(mobileWebShellDropsNavigation(navigation("/"), null, true))
  }

  @Test
  fun `refuses with an empty forbidden response`() {
    assertEquals(403, MOBILE_WEB_SHELL_REFUSAL_STATUS)
    assertEquals(0, mobileWebShellRefusalBody().size)
    assertEquals("no-store", MOBILE_WEB_SHELL_REFUSAL_HEADERS["Cache-Control"])
  }
}
