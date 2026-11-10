/// CSP belongs only on the document response; it is inert on subresources.
enum MobileWebShellResponseHeaders {
  static func forPath(
    _ path: String,
    contentType: String,
    byteCount: Int
  ) -> [String: String] {
    var headers = [
      "Content-Type": contentType,
      "Content-Length": String(byteCount),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    ]
    if path == "/" {
      headers["Content-Security-Policy"] = MobileWebShellCsp.header
      // HTTPS images can expose session identity: Android uses a hashed host, iOS the verbatim id.
      // WebKit srcdoc images leaked the embedder origin despite iframe referrerPolicy; set the document header.
      headers["Referrer-Policy"] = "no-referrer"
    }
    return headers
  }
}
