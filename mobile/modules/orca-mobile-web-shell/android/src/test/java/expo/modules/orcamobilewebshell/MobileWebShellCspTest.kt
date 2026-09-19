package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebShellCspTest {
  @Test
  fun `states every fetching directive so nothing falls back to the default`() {
    val directives = MOBILE_WEB_SHELL_CSP.split("; ")
    assertTrue(directives.contains("default-src 'none'"))
    assertTrue(directives.contains("script-src 'self'"))
    // React Native Web injects runtime styles with no nonce; see MobileWebShellCsp.
    assertTrue(directives.contains("style-src 'self' 'unsafe-inline'"))
    // A file preview is a `data:<mime>;base64,` URI the page composed from a reply it already
    // holds; see MobileWebShellCsp.
    assertTrue(directives.contains("img-src 'self' data:"))
    // The bootstrap page reads ./manifest.json from its own origin, which is one read-only
    // directory behind the manifest map, so 'self' reaches nothing it cannot already read.
    assertTrue(directives.contains("connect-src 'self'"))
    assertTrue(directives.contains("worker-src 'none'"))
    assertTrue(directives.contains("frame-src 'none'"))
    assertTrue(directives.contains("child-src 'none'"))
    assertTrue(directives.contains("object-src 'none'"))
    assertTrue(directives.contains("base-uri 'none'"))
    assertTrue(directives.contains("form-action 'none'"))
    assertTrue(directives.contains("frame-ancestors 'none'"))
  }

  @Test
  fun `grants nothing the build rules say the bundle never needs`() {
    // 'unsafe-inline' is granted to style-src and to nothing else: the page's code still has to
    // arrive as a fetched same-origin script, which is the directive that matters.
    val directives = MOBILE_WEB_SHELL_CSP.split("; ")
    assertEquals(
      listOf("style-src 'self' 'unsafe-inline'"),
      directives.filter { it.contains("unsafe-inline") }
    )
    assertTrue(directives.contains("script-src 'self'"))
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("unsafe-eval"))
    // Narrowed rather than absent: `data:` is a fetch source for images and for nothing else, so a
    // directive that grew one would fail here instead of passing a blanket absence check.
    assertEquals(
      listOf("img-src 'self' data:"),
      directives.filter { it.contains("data:") }
    )
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("blob:"))
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("http"))
  }

  @Test
  fun `is a single header line`() {
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("\r"))
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("\n"))
  }

  @Test
  fun `denies only what the native layer cannot see, with a shape the page cannot restore`() {
    val blocker = MOBILE_WEB_SHELL_NETWORK_API_BLOCKER
    // Whole definitions, not `contains("writable:false")`: one property's descriptor could lose a
    // flag and still match because another property still carries it.
    assertTrue(
      blocker.contains("globalThis,'WebSocket',{value:deny,configurable:false,writable:false}")
    )
    assertTrue(
      blocker.contains(
        "Navigator.prototype,'serviceWorker',{get:function(){return undefined},configurable:false}"
      )
    )
    assertTrue(
      blocker.contains("navigator,'serviceWorker',{value:undefined,configurable:false,writable:false}")
    )
    // CSP is the fence for fetch and XMLHttpRequest; a script that replaced them would put one
    // policy in two places and hide which one is actually holding.
    assertFalse(blocker.contains("fetch"))
    assertFalse(blocker.contains("XMLHttpRequest"))
  }
}
