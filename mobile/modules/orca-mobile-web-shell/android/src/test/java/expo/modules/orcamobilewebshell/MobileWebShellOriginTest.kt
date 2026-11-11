package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
