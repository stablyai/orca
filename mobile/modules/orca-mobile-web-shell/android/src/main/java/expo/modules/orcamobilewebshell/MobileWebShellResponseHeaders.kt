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
  }
  return headers
}
