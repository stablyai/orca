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
    // data: previews and https: icons/srcdoc images need image-only access; see MobileWebShellCsp.
    assertTrue(directives.contains("img-src 'self' data: blob: https:"))
    // Bootstrap reads manifest.json from the same read-only manifest-mapped directory.
    assertTrue(directives.contains("connect-src 'self'"))
    assertTrue(directives.contains("worker-src 'none'"))
    assertTrue(directives.contains("frame-src 'none'"))
    assertTrue(directives.contains("child-src 'none'"))
    assertTrue(directives.contains("object-src 'none'"))
    assertTrue(directives.contains("base-uri about:"))
    assertTrue(directives.contains("form-action 'none'"))
    assertTrue(directives.contains("frame-ancestors 'none'"))
  }

  @Test
  fun `grants nothing the build rules say the bundle never needs`() {
    // Inline styling must never grant inline script execution.
    val directives = MOBILE_WEB_SHELL_CSP.split("; ")
    assertEquals(
      listOf("style-src 'self' 'unsafe-inline'"),
      directives.filter { it.contains("unsafe-inline") }
    )
    assertTrue(directives.contains("script-src 'self'"))
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("unsafe-eval"))
    // Only images and bundled fonts can use embedded data URLs.
    assertEquals(
      listOf("img-src 'self' data: blob: https:", "font-src 'self' data:"),
      directives.filter { it.contains("data:") }
    )
    assertEquals(
      listOf("img-src 'self' data: blob: https:", "media-src blob:"),
      directives.filter { it.contains("blob:") }
    )
    // Admit https: only for images; http: is not a substring and remains forbidden.
    assertEquals(
      listOf("img-src 'self' data: blob: https:"),
      directives.filter { it.contains("https:") }
    )
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("http:"))
  }

  @Test
  fun `is a single header line`() {
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("\r"))
    assertFalse(MOBILE_WEB_SHELL_CSP.contains("\n"))
  }

  @Test
  fun `denies only what the native layer cannot see, with a shape the page cannot restore`() {
    val blocker = MOBILE_WEB_SHELL_NETWORK_API_BLOCKER
    // Check every descriptor: a surviving flag on one property must not mask another’s removal.
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
    // CSP owns fetch/XHR; replacing them would duplicate policy.
    assertFalse(blocker.contains("fetch"))
    assertFalse(blocker.contains("XMLHttpRequest"))
  }
}
