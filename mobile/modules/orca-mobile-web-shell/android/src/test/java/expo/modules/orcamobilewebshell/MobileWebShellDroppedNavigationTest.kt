package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private const val FOREIGN = "https://example.com/artifact-link"
private const val DOCUMENT = "orca-mobile-web://sess-01JN_aZ9/"

private fun verdict(
  url: String? = FOREIGN,
  isForMainFrame: Boolean = true,
  isDocumentUrl: Boolean = false,
  hasGesture: Boolean = true
) = mobileWebShellNavigationVerdict(
  url,
  isForMainFrame,
  false,
  isDocumentUrl,
  false,
  hasGesture,
  false
)

class MobileWebShellDroppedNavigationTest {

  @Test
  fun `refuses every navigation to the document that the shell did not ask for`() {
    // Artifact href=/ or empty href names our document; never reload or send that URL to the opener.
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(url = DOCUMENT, isDocumentUrl = true)
    )
    // Both engines can report no gesture for subframe top navigation; Chromium permits it for human requests too.
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(url = DOCUMENT, isDocumentUrl = true, hasGesture = false)
    )
  }

  @Test
  fun `cancels a foreign navigation with no gesture and offers nothing`() {
    // Meta refresh/redirects must not open a browser without a user action.
    assertEquals(MobileWebShellNavigationVerdict.Cancel, verdict(hasGesture = false))
  }

  @Test
  fun `offers nothing for a subframe, which is the sealed preview loading itself`() {
    assertEquals(MobileWebShellNavigationVerdict.Cancel, verdict(isForMainFrame = false))
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(isForMainFrame = false, hasGesture = false)
    )
  }

  @Test
  fun `offers nothing for an absent or empty url, and nothing past the crossing cap`() {
    assertEquals(MobileWebShellNavigationVerdict.Cancel, verdict(url = null))
    assertEquals(MobileWebShellNavigationVerdict.Cancel, verdict(url = ""))
    val cap = MOBILE_WEB_SHELL_MAX_DROPPED_NAVIGATION_URL_CHARS
    val atCap = "https://example.com/" + "a".repeat(cap - "https://example.com/".length)
    assertEquals(cap, atCap.length)
    assertEquals(atCap, mobileWebShellOfferableUrl(atCap))
    assertNull(mobileWebShellOfferableUrl(atCap + "a"))
    assertEquals(MobileWebShellNavigationVerdict.Cancel, verdict(url = atCap + "a"))
  }

}
