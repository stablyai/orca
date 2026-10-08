package expo.modules.orcamobilewebshell

/**
 * The headers one served asset answers with. Content-Type is not among them: `WebResourceResponse`
 * takes the mime type and the encoding as separate arguments.
 *
 * The policy header rides the document and nothing else: on a script or a stylesheet response it is
 * inert, and sending it everywhere would hide which response is the one that has to carry it.
 */
internal fun mobileWebShellResponseHeaders(path: String, byteCount: Int): Map<String, String> {
  val headers = mutableMapOf(
    "Content-Length" to byteCount.toString(),
    "Cache-Control" to "no-store",
    "X-Content-Type-Options" to "nosniff"
  )
  if (path == "/") {
    headers["Content-Security-Policy"] = MOBILE_WEB_SHELL_CSP
    // The document's origin here is a hashed host,
    // `https://<sha256(sessionId) first 32 hex>.orca-mobile-web.invalid/`, so a referrer carries a
    // stable per-session handle rather than the id itself; iOS serves
    // `orca-mobile-web://<sessionId>/` and carries the id verbatim. Either is something
    // an image host can key on across requests, and `img-src https:` is what made it reachable: an
    // image the artifact or a rendered document names is a request to someone else's host. The
    // iframe's own `referrerPolicy` does not cover it -- measured on WebKit, a srcdoc frame's image
    // request carried the embedder's origin anyway, where Chromium sent none -- so the guarantee
    // belongs on the document, where one header covers every request the page makes.
    headers["Referrer-Policy"] = "no-referrer"
  }
  return headers
}
