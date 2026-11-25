package expo.modules.orcamobilewebshell

/** Opened as a frame, any other response is an opaque-origin document with nothing allowed, so page script
 * cannot borrow its fresh WebSocket. Document-start scripts cover such frames, the page-script fallback does not. */
internal const val MOBILE_WEB_SHELL_NON_DOCUMENT_CSP = "sandbox; default-src 'none'"

/** The document's CSP is inert on subresources. WebResourceResponse takes MIME/encoding separately. */
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
  } else if (path == MOBILE_WEB_SHELL_CHAT_VISUAL_FRAME_PATH) {
    headers["Content-Security-Policy"] = MOBILE_WEB_SHELL_CHAT_VISUAL_FRAME_CSP
    headers["Referrer-Policy"] = "no-referrer"
  } else {
    headers["Content-Security-Policy"] = MOBILE_WEB_SHELL_NON_DOCUMENT_CSP
  }
  return headers
}
