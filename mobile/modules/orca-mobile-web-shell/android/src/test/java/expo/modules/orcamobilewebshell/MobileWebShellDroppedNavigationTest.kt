package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private const val FOREIGN = "https://example.com/artifact-link"
private const val DOCUMENT = "orca-mobile-web://sess-01JN_aZ9/"

private fun verdict(
  url: String? = FOREIGN,
  isForMainFrame: Boolean = true,
  isFromSubframe: Boolean = false,
  isDocumentUrl: Boolean = false,
  isShellLoad: Boolean = false,
  hasGesture: Boolean = true,
  isDownload: Boolean = false
) = mobileWebShellNavigationVerdict(
  url,
  isForMainFrame,
  isFromSubframe,
  isDocumentUrl,
  isShellLoad,
  hasGesture,
  isDownload
)

class MobileWebShellDroppedNavigationTest {
  @Test
  fun `cancels a foreign navigation a human started and offers it to the opener`() {
    assertEquals(MobileWebShellNavigationVerdict.CancelAndOffer(FOREIGN), verdict())
  }

  @Test
  fun `refuses every navigation to the document that the shell did not ask for`() {
    // `href="/"` and `href=""` in an artifact resolve against the embedder's base, so both name the
    // shell's own document. Refused whatever the host says about a gesture, and never offered:
    // handing the shell's own URL to the opener would send the user out of the app.
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(url = DOCUMENT, isDocumentUrl = true)
    )
    // The same navigation with no gesture reported, which is what a subframe's top navigation looks
    // like on both engines. Chromium's own documentation allows hasGesture() to be false for a
    // request a human started, so nothing here may rest on it.
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(url = DOCUMENT, isDocumentUrl = true, hasGesture = false)
    )
  }

  @Test
  fun `allows the document only for the load the shell itself started`() {
    assertEquals(
      MobileWebShellNavigationVerdict.Allow,
      verdict(url = DOCUMENT, isDocumentUrl = true, isShellLoad = true, hasGesture = false)
    )
    // Carried for the iOS twin, which can see the initiating frame: a subframe's navigation is not
    // the shell's load even if it arrives while the flag is up.
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(
        url = DOCUMENT,
        isFromSubframe = true,
        isDocumentUrl = true,
        isShellLoad = true,
        hasGesture = false
      )
    )
  }

  @Test
  fun `offers a foreign navigation a subframe started, which is the tap in the preview`() {
    assertEquals(
      MobileWebShellNavigationVerdict.CancelAndOffer(FOREIGN),
      verdict(isFromSubframe = true)
    )
  }

  @Test
  fun `cancels a foreign navigation with no gesture and offers nothing`() {
    // A top-page meta refresh or a redirect: refused, and never opened in a browser, because
    // nothing a human did asked for it.
    assertEquals(MobileWebShellNavigationVerdict.Cancel, verdict(hasGesture = false))
  }

  @Test
  fun `cancels a download rather than allowing it, and offers a gesture-started one`() {
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(
        url = DOCUMENT,
        isDocumentUrl = true,
        isShellLoad = true,
        hasGesture = false,
        isDownload = true
      )
    )
    assertEquals(
      MobileWebShellNavigationVerdict.CancelAndOffer(FOREIGN),
      verdict(isDownload = true)
    )
  }

  @Test
  fun `refuses a download that names the document, and offers it to nobody`() {
    // `<a href="/" download>` is the shell's own URL however it is dressed, and the one thing that
    // is never handed to the opener. Refused from either frame, gesture or not.
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(url = DOCUMENT, isDocumentUrl = true, isDownload = true)
    )
    assertEquals(
      MobileWebShellNavigationVerdict.Cancel,
      verdict(url = DOCUMENT, isFromSubframe = true, isDocumentUrl = true, isDownload = true)
    )
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

  @Test
  fun `says nothing about which schemes open, because TypeScript owns that list`() {
    // A scheme the opener will refuse still crosses: one filter, in the half that updates.
    assertEquals(
      MobileWebShellNavigationVerdict.CancelAndOffer("javascript:alert(1)"),
      verdict(url = "javascript:alert(1)")
    )
  }
}
