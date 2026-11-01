package expo.modules.orcamobilewebshell

/** CSP belongs only on the document response; it is inert on subresources. WebResourceResponse takes MIME/encoding separately. */
internal fun mobileWebShellResponseHeaders(path: String, byteCount: Int): Map<String, String> {
  val headers = mutableMapOf(
    "Content-Length" to byteCount.toString(),
    "Cache-Control" to "no-store",
    "X-Content-Type-Options" to "nosniff"
  )
  if (path == "/") {
    headers["Content-Security-Policy"] = MOBILE_WEB_SHELL_CSP
    // HTTPS images can expose session identity: Android uses a hashed host, iOS the verbatim id.
    // WebKit srcdoc images leaked the embedder origin despite iframe referrerPolicy; set the document header.
    headers["Referrer-Policy"] = "no-referrer"
  }
  return headers
}
