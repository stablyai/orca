package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val SESSION = "sess-01JN_aZ9"

private fun parts(
  path: String?,
  method: String = "GET",
  hasRangeHeader: Boolean = false,
  scheme: String? = "https",
  host: String? = mobileWebShellOriginHost(SESSION),
  port: Int = -1,
  userInfo: String? = null,
  query: String? = null,
  fragment: String? = null,
  urlLength: Int = 64
) = MobileWebShellRequestParts(
  method = method,
  hasRangeHeader = hasRangeHeader,
  scheme = scheme,
  host = host,
  port = port,
  userInfo = userInfo,
  query = query,
  fragment = fragment,
  encodedPath = path,
  urlLength = urlLength
)

private fun resolve(request: MobileWebShellRequestParts): String? =
  resolveMobileWebShellRequestPath(request, mobileWebShellOriginHost(SESSION)!!)

class MobileWebShellOriginTest {
  @Test
  fun `accepts only base64url session ids within the length bound`() {
    assertTrue(isMobileWebShellSessionId("aZ0-_"))
    assertTrue(isMobileWebShellSessionId("a".repeat(128)))
    assertFalse(isMobileWebShellSessionId("a".repeat(129)))
    assertFalse(isMobileWebShellSessionId(""))
    assertFalse(isMobileWebShellSessionId("has space"))
    assertFalse(isMobileWebShellSessionId("dots.are.hosts.too"))
    assertFalse(isMobileWebShellSessionId("sl/ash"))
    assertFalse(isMobileWebShellSessionId("sessioñ"))
  }

  @Test
  fun `labels the origin with a hash of the session id, never a slice of it`() {
    val host = mobileWebShellOriginHost(SESSION)!!
    val label = host.substringBefore('.')
    assertEquals(32, label.length)
    assertTrue(label.all { it in '0'..'9' || it in 'a'..'f' })
    // The bug this replaces: a label sliced off the session id carried case and '_', which
    // Chromium and java.net.URI canonicalise differently, so every asset 403'd.
    assertFalse(label.startsWith(SESSION.take(8)))
    assertEquals("$label.orca-mobile-web.invalid", host)
    assertEquals("https://$host", mobileWebShellOrigin(SESSION))
    assertNull(mobileWebShellOriginHost("bad host"))
    assertNull(mobileWebShellOrigin("bad host"))
  }

  @Test
  fun `derives a different label for every session and the same one for a repeat`() {
    assertEquals(mobileWebShellOriginHost(SESSION), mobileWebShellOriginHost(SESSION))
    assertTrue(mobileWebShellOriginHost(SESSION) != mobileWebShellOriginHost("${SESSION}a"))
    // Case matters to the derivation even though the host comparison ignores it.
    assertTrue(mobileWebShellOriginHost(SESSION) != mobileWebShellOriginHost(SESSION.uppercase()))
  }

  @Test
  fun `serves the document and a declared asset path`() {
    assertEquals("/", resolve(parts("/")))
    assertEquals("/", resolve(parts("")))
    assertEquals("/assets/aa.js", resolve(parts("/assets/aa.js")))
  }

  @Test
  fun `binds a host the parser canonicalised`() {
    assertEquals("/", resolve(parts("/", host = mobileWebShellOriginHost(SESSION)!!.uppercase())))
  }

  @Test
  fun `refuses everything outside a plain GET on this origin`() {
    assertNull(resolve(parts("/", method = "POST")))
    assertNull(resolve(parts("/", method = "HEAD")))
    assertNull(resolve(parts("/", hasRangeHeader = true)))
    assertNull(resolve(parts("/", scheme = "http")))
    assertNull(resolve(parts("/", scheme = null)))
    assertNull(resolve(parts("/", host = "other.orca-mobile-web.invalid")))
    assertNull(resolve(parts("/", host = null)))
    assertNull(resolve(parts("/", port = 443)))
    assertNull(resolve(parts("/", userInfo = "someone")))
    assertNull(resolve(parts("/", query = "v=1")))
    assertNull(resolve(parts("/", fragment = "frag")))
    assertNull(resolve(parts("/assets/%2e%2e/etc")))
    assertNull(resolve(parts("assets/aa.js")))
    assertNull(resolve(parts(null)))
    assertEquals("/", resolve(parts("/", urlLength = 8 * 1024)))
    assertNull(resolve(parts("/", urlLength = 8 * 1024 + 1)))
  }
}
