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
    }
    return headers
  }
}
