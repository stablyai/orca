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
    // The document origin is the session id, and `img-src https:` gives the page somewhere to send
    // it. See MobileWebShellResponseHeaders.
    assertEquals("no-referrer", headers["Referrer-Policy"])
  }

  @Test
  fun `sends the policy on nothing else`() {
    for (path in listOf("/index.html", "/assets/aa.js", "/manifest.json", "/assets/bb.png")) {
      val headers = mobileWebShellResponseHeaders(path, 12)
      assertNull(headers["Content-Security-Policy"])
      // Rides the document with the policy: on a subresource response it governs nothing, since
      // the referrer of a request is decided by the document that made it.
      assertNull(headers["Referrer-Policy"])
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
