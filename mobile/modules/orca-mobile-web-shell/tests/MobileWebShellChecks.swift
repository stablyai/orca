import Foundation

// Everything the shell decides before WebKit is involved: the session id it will accept, the
// requests it will answer, the map it builds from a manifest, and the policy header. Compiled and
// run without a device:
//
//   swiftc -O -o /tmp/mobile-web-shell-checks \
//     ios/MobileWebShellOrigin.swift ios/MobileWebShellGeneration.swift ios/MobileWebShellCsp.swift \
//     ios/MobileWebShellLoadState.swift ios/MobileWebShellResponseHeaders.swift \
//     tests/MobileWebShellChecks.swift && /tmp/mobile-web-shell-checks
@main struct MobileWebShellChecks {
  static let session = "sess-01JN_aZ9"

  static func parts(
    path: String,
    method: String = "GET",
    hasRangeHeader: Bool = false,
    scheme: String? = MobileWebShellOrigin.scheme,
    host: String? = session,
    port: Int? = nil,
    user: String? = nil,
    query: String? = nil,
    fragment: String? = nil,
    urlByteCount: Int = 64
  ) -> MobileWebShellRequestParts {
    MobileWebShellRequestParts(
      method: method,
      hasRangeHeader: hasRangeHeader,
      scheme: scheme,
      host: host,
      port: port,
      user: user,
      query: query,
      fragment: fragment,
      percentEncodedPath: path,
      urlByteCount: urlByteCount
    )
  }

  static func resolve(_ request: MobileWebShellRequestParts) -> String? {
    MobileWebShellOrigin.resolveRequestPath(request, sessionId: session)
  }

  static func manifest(
    schemaVersion: Int = 1,
    entrypoint: String = "index.html",
    assets: [[String: Any]] = [
      ["path": "index.html", "contentType": "text/html; charset=utf-8"],
      ["path": "assets/aa.js", "contentType": "text/javascript; charset=utf-8"],
      ["path": "assets/bb.png", "contentType": "image/png"]
    ]
  ) -> Data {
    let root: [String: Any] = [
      "schemaVersion": schemaVersion,
      "entrypoint": entrypoint,
      "assets": assets
    ]
    return try! JSONSerialization.data(withJSONObject: root)
  }

  static func generation(_ data: Data) -> MobileWebShellGeneration? {
    try? MobileWebShellGeneration.make(
      manifestData: data,
      directory: URL(fileURLWithPath: "/tmp/generation", isDirectory: true)
    )
  }

  static func checkSessionIds() {
    precondition(MobileWebShellOrigin.isValidSessionId("aZ0-_"))
    precondition(MobileWebShellOrigin.isValidSessionId(String(repeating: "a", count: 128)))
    precondition(!MobileWebShellOrigin.isValidSessionId(String(repeating: "a", count: 129)))
    precondition(!MobileWebShellOrigin.isValidSessionId(""))
    precondition(!MobileWebShellOrigin.isValidSessionId("has space"))
    precondition(!MobileWebShellOrigin.isValidSessionId("dots.are.hosts.too"))
    precondition(!MobileWebShellOrigin.isValidSessionId("sl/ash"))
    // Non-ASCII letters and digits satisfy Character.isLetter/isNumber, so the ASCII gate is load
    // bearing: an IDNA-mapped host would not be the origin we minted.
    precondition(!MobileWebShellOrigin.isValidSessionId("sessioñ"))
    precondition(!MobileWebShellOrigin.isValidSessionId("session٣"))
    precondition(MobileWebShellOrigin.documentUrl(sessionId: session)?.absoluteString ==
      "orca-mobile-web://\(session)/")
    precondition(MobileWebShellOrigin.documentUrl(sessionId: "bad host") == nil)
  }

  static func checkRequestResolution() {
    precondition(resolve(parts(path: "/")) == "/")
    precondition(resolve(parts(path: "")) == "/")
    precondition(resolve(parts(path: "/assets/aa.js")) == "/assets/aa.js")
    // A host a parser canonicalised must still bind to this session.
    precondition(resolve(parts(path: "/", host: session.uppercased())) == "/")

    precondition(resolve(parts(path: "/", method: "POST")) == nil)
    precondition(resolve(parts(path: "/", method: "HEAD")) == nil)
    precondition(resolve(parts(path: "/", hasRangeHeader: true)) == nil)
    precondition(resolve(parts(path: "/", scheme: "https")) == nil)
    precondition(resolve(parts(path: "/", scheme: nil)) == nil)
    precondition(resolve(parts(path: "/", host: "other-session")) == nil)
    precondition(resolve(parts(path: "/", host: nil)) == nil)
    precondition(resolve(parts(path: "/", port: 443)) == nil)
    precondition(resolve(parts(path: "/", user: "someone")) == nil)
    precondition(resolve(parts(path: "/", query: "v=1")) == nil)
    precondition(resolve(parts(path: "/", fragment: "frag")) == nil)
    precondition(resolve(parts(path: "/assets/%2e%2e/etc")) == nil)
    precondition(resolve(parts(path: "assets/aa.js")) == nil)
    precondition(resolve(parts(path: "/", urlByteCount: 8 * 1024)) == "/")
    precondition(resolve(parts(path: "/", urlByteCount: 8 * 1024 + 1)) == nil)
    precondition(MobileWebShellOrigin.resolveRequestPath(parts(path: "/"), sessionId: "") == nil)
  }

  static func checkAssetPaths() {
    precondition(MobileWebShellGeneration.isServableAssetPath("index.html"))
    precondition(MobileWebShellGeneration.isServableAssetPath("assets/a-b_c.2.js"))
    precondition(!MobileWebShellGeneration.isServableAssetPath(""))
    precondition(!MobileWebShellGeneration.isServableAssetPath("/leading"))
    precondition(!MobileWebShellGeneration.isServableAssetPath("trailing/"))
    precondition(!MobileWebShellGeneration.isServableAssetPath("a//b"))
    precondition(!MobileWebShellGeneration.isServableAssetPath("../secret"))
    precondition(!MobileWebShellGeneration.isServableAssetPath("assets/../../secret"))
    precondition(!MobileWebShellGeneration.isServableAssetPath("assets/./a.js"))
    precondition(!MobileWebShellGeneration.isServableAssetPath("back\\slash"))
    precondition(!MobileWebShellGeneration.isServableAssetPath("has space.js"))
    precondition(MobileWebShellGeneration.isServableAssetPath(String(repeating: "a", count: 255)))
    precondition(!MobileWebShellGeneration.isServableAssetPath(String(repeating: "a", count: 256)))
  }

  static func checkContentTypes() {
    precondition(MobileWebShellGeneration.isServableContentType("image/png"))
    precondition(MobileWebShellGeneration.isServableContentType("text/html; charset=utf-8"))
    precondition(MobileWebShellGeneration.isServableContentType("application/manifest+json"))
    precondition(!MobileWebShellGeneration.isServableContentType(""))
    precondition(!MobileWebShellGeneration.isServableContentType("text/html"
      + "\r\nX-Injected: 1"))
    precondition(!MobileWebShellGeneration.isServableContentType("text/html; charset=utf-8; x=1"))
    precondition(!MobileWebShellGeneration.isServableContentType("TEXT/HTML"))
    // A header value we did not mint character for character is a value we did not check.
    precondition(!MobileWebShellGeneration.isServableContentType("text/html; charset=UTF-8"))
    precondition(!MobileWebShellGeneration.isServableContentType("text"))
    precondition(!MobileWebShellGeneration.isServableContentType("text/html/extra"))
    precondition(!MobileWebShellGeneration.isServableContentType("/html"))
    precondition(!MobileWebShellGeneration.isServableContentType("-text/html"))
    precondition(!MobileWebShellGeneration.isServableContentType("text/html; charset="))
    precondition(!MobileWebShellGeneration.isServableContentType(
      String(repeating: "a", count: 130) + "/b"))
  }

  static func checkGenerationMap() {
    guard let built = generation(manifest()) else { preconditionFailure("manifest rejected") }
    precondition(built.entries.count == 4)
    precondition(built.entries["/"]?.file.path == "/tmp/generation/index.html")
    precondition(built.entries["/"]?.contentType == "text/html; charset=utf-8")
    // Only "/" reaches the document: a second URL for the same bytes would answer without the CSP
    // header, which rides the document response alone.
    precondition(built.entries["/index.html"] == nil)
    precondition(built.entries["/assets/aa.js"]?.contentType == "text/javascript; charset=utf-8")
    precondition(built.entries["/assets/bb.png"]?.file.path == "/tmp/generation/assets/bb.png")
    precondition(built.entries["/manifest.json"]?.contentType == "application/json")
    precondition(built.entries["/assets/cc.js"] == nil)
    precondition(built.entries["/../secret"] == nil)

    precondition(generation(manifest(schemaVersion: 2)) == nil)
    precondition(generation(manifest(entrypoint: "start.html")) == nil)
    precondition(generation(manifest(assets: [])) == nil)
    // The entrypoint must be one of the assets, or "/" would map to a file nobody declared.
    precondition(generation(manifest(assets: [
      ["path": "assets/aa.js", "contentType": "text/javascript; charset=utf-8"]
    ])) == nil)
    precondition(generation(manifest(assets: [
      ["path": "index.html", "contentType": "text/html; charset=utf-8"],
      ["path": "../escape.js", "contentType": "text/javascript; charset=utf-8"]
    ])) == nil)
    precondition(generation(manifest(assets: [
      ["path": "index.html", "contentType": "text/html; charset=utf-8"],
      ["path": "assets/aa.js", "contentType": "text/javascript\r\nX-Injected: 1"]
    ])) == nil)
    precondition(generation(manifest(assets: [
      ["path": "index.html", "contentType": "text/html; charset=utf-8"],
      ["path": 7, "contentType": "text/javascript; charset=utf-8"]
    ])) == nil)
    let tooMany = (0..<257).map { index in
      ["path": "assets/a\(index).js", "contentType": "text/javascript; charset=utf-8"]
    }
    precondition(generation(manifest(assets: tooMany)) == nil)
    // A JSON string is not a JSON number, and true and 1.0 are not the integer 1, though NSNumber
    // bridges all three to something `as? Int` accepts.
    precondition(generation(Data(#"{"schemaVersion":true,"entrypoint":"index.html","assets":[{"path":"index.html","contentType":"text/html"}]}"#.utf8)) == nil)
    precondition(generation(Data(#"{"schemaVersion":1.0,"entrypoint":"index.html","assets":[{"path":"index.html","contentType":"text/html"}]}"#.utf8)) == nil)
    precondition(generation(Data(#"{"schemaVersion":1,"entrypoint":"index.html","assets":[{"path":"index.html","contentType":"text/html"}]}"#.utf8)) != nil)
    precondition(generation(Data(#"{"schemaVersion":"1","entrypoint":"index.html","assets":[{"path":"index.html","contentType":"text/html"}]}"#.utf8)) == nil)
    precondition(generation(Data("not json".utf8)) == nil)
    precondition(generation(Data("[]".utf8)) == nil)
  }

  static func checkCsp() {
    let header = MobileWebShellCsp.header
    let directives = header.components(separatedBy: "; ")
    precondition(directives.contains("default-src 'none'"))
    precondition(directives.contains("script-src 'self'"))
    precondition(directives.contains("connect-src 'self'"))
    precondition(directives.contains("worker-src 'none'"))
    precondition(directives.contains("frame-src 'none'"))
    precondition(directives.contains("base-uri 'none'"))
    precondition(directives.contains("form-action 'none'"))
    precondition(directives.contains("frame-ancestors 'none'"))
    // An inline script or an eval would make the no-inline-script build rule unenforced.
    precondition(!header.contains("unsafe-inline"))
    precondition(!header.contains("unsafe-eval"))
    precondition(!header.contains("data:"))
    precondition(!header.contains("blob:"))
    precondition(!header.contains("\r") && !header.contains("\n"))
  }

  static func checkLoadStateMachine() {
    precondition(MobileWebShellFailureReason.generationUnreadable.rawValue == "generation-unreadable")
    precondition(MobileWebShellFailureReason.isolationUnavailable.rawValue == "isolation-unavailable")
    precondition(MobileWebShellFailureReason.documentLoadFailed.rawValue == "document-load-failed")
    precondition(MobileWebShellFailureReason.renderProcessGone.rawValue == "render-process-gone")

    let progress = MobileWebShellLoadStateMachine()
    precondition(progress.started()?.state == "loading")
    precondition(progress.started() == nil)
    precondition(progress.finished()?.state == "ready")
    precondition(progress.finished() == nil)

    // A rule list compiles asynchronously, so it can fail after the generation was already refused.
    let refused = MobileWebShellLoadStateMachine()
    precondition(refused.failed(.generationUnreadable)?.reason == "generation-unreadable")
    precondition(refused.failed(.isolationUnavailable) == nil)
    precondition(refused.failed(.renderProcessGone) == nil)
    precondition(refused.finished() == nil)
    precondition(refused.started() == nil)

    refused.reset()
    precondition(refused.failed(.generationUnreadable)?.reason == "generation-unreadable")
  }

  static func checkResponseHeaders() {
    let document = MobileWebShellResponseHeaders.forPath(
      "/",
      contentType: "text/html; charset=utf-8",
      byteCount: 12
    )
    precondition(document["Content-Security-Policy"] == MobileWebShellCsp.header)
    precondition(document["Content-Type"] == "text/html; charset=utf-8")
    precondition(document["Content-Length"] == "12")
    precondition(document["Cache-Control"] == "no-store")
    precondition(document["X-Content-Type-Options"] == "nosniff")

    // The policy rides the document alone; on a subresource response it is inert.
    for path in ["/index.html", "/assets/aa.js", "/manifest.json", "/assets/bb.png"] {
      let headers = MobileWebShellResponseHeaders.forPath(
        path,
        contentType: "text/javascript; charset=utf-8",
        byteCount: 0
      )
      precondition(headers["Content-Security-Policy"] == nil)
      precondition(headers["Cache-Control"] == "no-store")
      precondition(headers["X-Content-Type-Options"] == "nosniff")
    }
  }

  static func checkNavigationErrors() {
    let ignorable = MobileWebShellNavigationError.isIgnorable
    // Our own stopLoading on a prop update, and every navigation the policy delegate refuses.
    precondition(ignorable(NSURLErrorDomain, NSURLErrorCancelled))
    precondition(ignorable("WebKitErrorDomain", 102))
    // Anything else is the document failing to load, which is the caller's cue to redownload.
    precondition(!ignorable(NSURLErrorDomain, NSURLErrorNetworkConnectionLost))
    precondition(!ignorable(NSURLErrorDomain, NSURLErrorResourceUnavailable))
    precondition(!ignorable("WebKitErrorDomain", 101))
    precondition(!ignorable("WebKitErrorDomain", NSURLErrorCancelled))
    // WKErrorDomain has no frame-load codes at all, so 102 there is some other error.
    precondition(!ignorable("WKErrorDomain", 102))
    precondition(!ignorable("SomeOtherDomain", 102))
  }

  static func main() {
    checkSessionIds()
    checkRequestResolution()
    checkAssetPaths()
    checkContentTypes()
    checkGenerationMap()
    checkCsp()
    checkLoadStateMachine()
    checkResponseHeaders()
    checkNavigationErrors()
    print("mobile web shell checks OK")
  }
}
