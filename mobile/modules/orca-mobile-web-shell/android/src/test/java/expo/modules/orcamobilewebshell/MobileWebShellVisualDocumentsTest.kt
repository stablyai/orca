package expo.modules.orcamobilewebshell

import org.junit.Assert.*
import org.junit.Test

class MobileWebShellVisualDocumentsTest {
  @Test fun `documents are isolated by instance and disappear on release or session reset`() {
    val page = MobileWebShellVisualDocuments()
    val other = MobileWebShellVisualDocuments()
    val path = page.create("<button>Report</button>")
    assertTrue(path.startsWith(MOBILE_WEB_SHELL_VISUAL_PREFIX))
    assertEquals("<button>Report</button>", page.read(path)?.toString(Charsets.UTF_8))
    assertNull(other.read(path))
    assertNull(page.read("$path?copy"))
    page.remove(path)
    assertNull(page.read(path))
    val next = page.create("Another report")
    page.clear()
    assertNull(page.read(next))
  }

  @Test fun `byte and document limits cannot be bypassed by multibyte text or repeated reports`() {
    val page = MobileWebShellVisualDocuments()
    assertThrows(IllegalArgumentException::class.java) { page.create("я".repeat(600_000)) }
    repeat(32) { page.create("Report") }
    assertThrows(IllegalArgumentException::class.java) { page.create("Overflow") }
    page.clear()
    repeat(16) { page.create("a".repeat(1024 * 1024)) }
    assertThrows(IllegalArgumentException::class.java) { page.create("Overflow") }
    page.clear()
    assertNotNull(page.read(page.create("Room was released")))
  }

  @Test fun `author scripts are confined to an opaque offline document and never enabled on the chat`() {
    val page = mobileWebShellResponseHeaders("/", 1)
    val visual = mobileWebShellResponseHeaders("${MOBILE_WEB_SHELL_VISUAL_PREFIX}report.html", 1)
    assertTrue(page.getValue("Content-Security-Policy").contains("script-src 'self'"))
    assertFalse(page.getValue("Content-Security-Policy").contains("script-src 'unsafe-inline'"))
    val policy = visual.getValue("Content-Security-Policy")
    assertTrue(policy.contains("script-src 'unsafe-inline'"))
    assertTrue(policy.contains("sandbox allow-scripts"))
    assertFalse(policy.contains("allow-same-origin"))
    assertTrue(policy.contains("connect-src 'none'"))
    assertTrue(policy.contains("frame-src 'none'"))
    assertEquals("no-store", visual["Cache-Control"])
    assertEquals("no-referrer", visual["Referrer-Policy"])
  }
}
