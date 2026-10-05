/// The headers one served asset answers with.
///
/// The policy header rides the document and nothing else: on a script or a stylesheet response it
/// is inert, and sending it everywhere would hide which response is the one that has to carry it.
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
      // The document's origin is `orca-mobile-web://<sessionId>/` -- a custom scheme's host is
      // opaque, so the id is used verbatim and a referrer carries it. Android hashes it into a
      // host instead; see its twin. `img-src https:` made that reachable: an image the
      // artifact or a markdown document names is a request to someone else's host. The iframe's
      // own `referrerPolicy` does not cover it -- measured on WebKit, a srcdoc frame's image
      // request carried the embedder's origin anyway, where Chromium sent none -- so the guarantee
      // belongs on the document, where one header covers every request the page makes.
      headers["Referrer-Policy"] = "no-referrer"
    }
    return headers
  }
}
