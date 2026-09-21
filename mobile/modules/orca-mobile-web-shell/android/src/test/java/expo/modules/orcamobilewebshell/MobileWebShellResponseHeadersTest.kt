package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MobileWebShellResponseHeadersTest {
  @Test
  fun `sends the policy on the document`() {
    val headers = mobileWebShellResponseHeaders("/", 12)
    assertEquals(MOBILE_WEB_SHELL_CSP, headers["Content-Security-Policy"])
    assertEquals("12", headers["Content-Length"])
    assertEquals("no-store", headers["Cache-Control"])
    assertEquals("nosniff", headers["X-Content-Type-Options"])
  }

  @Test
  fun `sends the policy on nothing else`() {
    for (path in listOf("/index.html", "/assets/aa.js", "/manifest.json", "/assets/bb.png")) {
      assertNull(mobileWebShellResponseHeaders(path, 12)["Content-Security-Policy"])
    }
  }

  @Test
  fun `caches nothing, whatever the path`() {
    val headers = mobileWebShellResponseHeaders("/assets/aa.js", 0)
    assertEquals("no-store", headers["Cache-Control"])
    assertEquals("nosniff", headers["X-Content-Type-Options"])
    // WebResourceResponse takes the mime type and the encoding as arguments, not as a header.
    assertNull(headers["Content-Type"])
  }
}
