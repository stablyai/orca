import Foundation

// Everything the shell decides before WebKit is involved: the session id it will accept, the
// requests it will answer, the map it builds from a manifest, and the policy header. Compiled and
// run without a device:
//
//   swiftc -O -o /tmp/mobile-web-shell-checks \
//     ios/MobileWebShellOrigin.swift ios/MobileWebShellGeneration.swift ios/MobileWebShellCsp.swift \
//     ios/MobileWebShellLoadState.swift ios/MobileWebShellResponseHeaders.swift \
//     ios/MobileWebShellBridge.swift ios/MobileWebShellAppliedProps.swift \
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
    // The same ASCII-only fold as the bridge: a Kelvin-sign host is a host nobody minted, and a
    // caseInsensitiveCompare here would serve it every asset.
    precondition(MobileWebShellOrigin.resolveRequestPath(
      parts(path: "/", host: "\u{212A}ey"),
      sessionId: "key"
    ) == nil)
    precondition(MobileWebShellOrigin.resolveRequestPath(
      parts(path: "/", host: "KEY"),
      sessionId: "key"
    ) == "/")
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
    // React Native Web injects runtime styles with no nonce; see MobileWebShellCsp.
    precondition(directives.contains("style-src 'self' 'unsafe-inline'"))
    // A file preview is a `data:<mime>;base64,` URI the page composed from a reply it already
    // holds; see MobileWebShellCsp.
    precondition(directives.contains("img-src 'self' data:"))
    precondition(directives.contains("connect-src 'self'"))
    precondition(directives.contains("worker-src 'none'"))
    precondition(directives.contains("frame-src 'none'"))
    precondition(directives.contains("base-uri 'none'"))
    precondition(directives.contains("form-action 'none'"))
    precondition(directives.contains("frame-ancestors 'none'"))
    // 'unsafe-inline' is granted to style-src and to nothing else: the page's code still has to
    // arrive as a fetched same-origin script, which is the directive that matters.
    precondition(directives.filter { $0.contains("unsafe-inline") } == ["style-src 'self' 'unsafe-inline'"])
    precondition(!header.contains("unsafe-eval"))
    // Narrowed rather than absent: `data:` is a fetch source for images and for nothing else, so a
    // directive that grew one would fail here instead of passing a blanket absence check.
    precondition(directives.filter { $0.contains("data:") } == ["img-src 'self' data:"])
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
    progress.committed()
    precondition(progress.finished()?.state == "ready")
    precondition(progress.finished() == nil)

    // The document's path is not an input here, and that is the point: the page rewrites its own
    // with history.replaceState before its first render, so `didFinish` arrives at a URL no policy
    // would allow. What is asked instead is whether this load committed.
    let unseated = MobileWebShellLoadStateMachine()
    _ = unseated.started()
    precondition(unseated.finished() == nil)
    unseated.committed()
    precondition(unseated.finished()?.state == "ready")

    // A document replaced mid-load: the finish belongs to the one that is already gone.
    let replaced = MobileWebShellLoadStateMachine()
    replaced.committed()
    replaced.documentEnded()
    precondition(replaced.finished() == nil)

    // A rule list compiles asynchronously, so it can fail after the generation was already refused.
    let refused = MobileWebShellLoadStateMachine()
    precondition(refused.failed(.generationUnreadable)?.reason == "generation-unreadable")
    precondition(refused.failed(.isolationUnavailable) == nil)
    precondition(refused.failed(.renderProcessGone) == nil)
    precondition(refused.finished() == nil)
    precondition(refused.started() == nil)

    refused.reset()
    precondition(refused.failed(.generationUnreadable)?.reason == "generation-unreadable")

    // A document is heard only between its own commit and the end of that load.
    let arming = MobileWebShellLoadStateMachine()
    precondition(!arming.hasCommittedDocument)
    _ = arming.started()
    // The previous document is alive and same-origin until the next one commits.
    precondition(!arming.hasCommittedDocument)
    arming.committed()
    precondition(arming.hasCommittedDocument)

    // A new prop triple: the committed document is the one being replaced.
    arming.reset()
    precondition(!arming.hasCommittedDocument)
    arming.committed()
    arming.documentEnded()
    precondition(!arming.hasCommittedDocument)

    // A failure ends the document, and nothing after it re-arms: a retry is a remount.
    arming.committed()
    _ = arming.failed(.renderProcessGone)
    precondition(!arming.hasCommittedDocument)
    arming.committed()
    precondition(!arming.hasCommittedDocument)
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

  static func bridgeSource(
    isOurWebView: Bool = true,
    isMainFrame: Bool = true,
    hasCommittedDocument: Bool = true,
    originProtocol: String = MobileWebShellOrigin.scheme,
    originHost: String = session
  ) -> MobileWebShellBridgeSource {
    MobileWebShellBridgeSource(
      isOurWebView: isOurWebView,
      isMainFrame: isMainFrame,
      hasCommittedDocument: hasCommittedDocument,
      originProtocol: originProtocol,
      originHost: originHost
    )
  }

  static func acceptsBridge(_ source: MobileWebShellBridgeSource) -> Bool {
    MobileWebShellBridge.accepts(source, sessionId: session)
  }

  static func checkAppliedProps() {
    func props(
      directory: String = "/gen/aa",
      session: String = session,
      bridge: Bool = true
    ) -> MobileWebShellAppliedProps {
      MobileWebShellAppliedProps(
        generationDirectory: directory,
        sessionId: session,
        bridgeEnabled: bridge
      )
    }

    precondition(props().matches(props()))
    precondition(!props().matches(props(directory: "/gen/ab")))
    precondition(!props().matches(props(session: "sess-01JN_aZ8")))
    precondition(!props().matches(props(bridge: false)))
    // A triple that could not be honoured is still applied: re-entry reads the props, never whether
    // the install succeeded, so a corrupt generation reports its failure once rather than on every
    // commit for the life of the mount.
    precondition(props(directory: "/gen/corrupt").matches(props(directory: "/gen/corrupt")))

    // A fourth prop that nobody compared is a prop that silently never reloads, so the record's
    // shape is pinned here rather than left to whoever adds the field.
    let fields = Mirror(reflecting: props()).children.compactMap(\.label).sorted()
    precondition(fields == ["bridgeEnabled", "generationDirectory", "sessionId"])
  }

  static func checkBridgeAcceptance() {
    precondition(acceptsBridge(bridgeSource()))
    // Simulator-measured: WebKit reports the custom scheme's host ASCII-lowercased, so the session
    // we minted never equals the host verbatim. Exact equality here refuses every message.
    precondition(acceptsBridge(bridgeSource(originHost: "sess-01jn_az9")))
    precondition(acceptsBridge(bridgeSource(originHost: "SESS-01JN_AZ9")))

    // A frame we did not serve.
    precondition(!acceptsBridge(bridgeSource(originHost: "sess-01JN_aZ8")))
    precondition(!acceptsBridge(bridgeSource(originHost: "")))
    precondition(!acceptsBridge(bridgeSource(originHost: "sess-01JN_aZ9.evil")))
    // ASCII folding only: U+212A KELVIN SIGN lowercases to "k" under Unicode case folding, so a
    // caseInsensitiveCompare would accept a host nobody minted.
    precondition(!MobileWebShellBridge.accepts(
      bridgeSource(originHost: "\u{212A}ey"),
      sessionId: "key"
    ))
    precondition(MobileWebShellOrigin.asciiLowercased("\u{212A}EY") == "\u{212A}ey")

    // Another scheme reaching the same handler.
    precondition(!acceptsBridge(bridgeSource(originProtocol: "https")))
    precondition(!acceptsBridge(bridgeSource(originProtocol: "")))
    precondition(!acceptsBridge(bridgeSource(originProtocol: "orca-mobile-web ")))

    // A subframe, and a message routed to a WebView that is not ours.
    precondition(!acceptsBridge(bridgeSource(isMainFrame: false)))
    precondition(!acceptsBridge(bridgeSource(isOurWebView: false)))

    // The document the current props replaced: same session, same origin, still alive between
    // `stopLoading` and the next commit, speaking for a load already reported as `loading`.
    precondition(!acceptsBridge(bridgeSource(hasCommittedDocument: false)))

    // No applied session is not an empty one: nothing may be accepted before a load.
    precondition(!MobileWebShellBridge.accepts(bridgeSource(originHost: ""), sessionId: ""))
    precondition(!MobileWebShellBridge.accepts(bridgeSource(originHost: "a b"), sessionId: "a b"))
  }

  static func checkBridgePostTarget() {
    func canPost(
      _ host: String?,
      _ sessionId: String = session,
      committed: Bool = true
    ) -> Bool {
      MobileWebShellBridge.canPost(
        toFrameOriginHost: host,
        sessionId: sessionId,
        hasCommittedDocument: committed
      )
    }

    precondition(canPost(session))
    // The same ASCII fold as acceptance: WebKit reports the host lowercased.
    precondition(canPost("sess-01jn_az9"))

    // Nowhere to post, all four for the same reason: no frame has been accepted. A page that has
    // never spoken, a document whose load failed, a renderer that died, a bridge not installed.
    precondition(!canPost(nil))

    // A frame from another document, and a frame under no session at all.
    precondition(!canPost("sess-01JN_aZ8"))
    precondition(!canPost("\u{212A}ey", "key"))
    precondition(!canPost(session, ""))
    precondition(!canPost("", ""))

    // In flight: a navigation has started and not committed, so there is no document to post into
    // even while a frame from the one being replaced is still held.
    precondition(!canPost(session, committed: false))
  }

  /// The target across one document replacing another, in the order the navigation delegate runs:
  /// a frame armed by document A is never what a post to document B goes to.
  static func checkBridgeTargetLifecycle() {
    func canPost(_ target: MobileWebShellBridgeTarget<String>, committed: Bool) -> Bool {
      MobileWebShellBridge.canPost(
        toFrameOriginHost: target.originHost,
        sessionId: session,
        hasCommittedDocument: committed
      )
    }

    var target = MobileWebShellBridgeTarget<String>()
    precondition(target.frame == nil && target.originHost == nil)
    precondition(!canPost(target, committed: true))

    // didCommit for document A, then A's first accepted message.
    target.clear()
    target.arm(frame: "frame-a", originHost: session)
    precondition(target.frame == "frame-a")
    precondition(canPost(target, committed: true))

    // didStartProvisionalNavigation for document B. Refused twice over: nothing armed, and nothing
    // committed to post into.
    target.clear()
    precondition(target.frame == nil)
    precondition(!canPost(target, committed: false))

    // didCommit for document B. Arming re-opens, so the clear has to happen here as well or A's
    // frame becomes postable again as B's.
    target.clear()
    precondition(!canPost(target, committed: true))

    // B speaks for itself, and that is the only way a post reaches it.
    target.arm(frame: "frame-b", originHost: session)
    precondition(target.frame == "frame-b")
    precondition(canPost(target, committed: true))
  }

  static func checkBridgeByteCap() {
    let cap = MobileWebShellBridge.maxMessageByteCount
    precondition(cap == 640 * 1024)
    precondition(MobileWebShellBridge.acceptsByteCount(0))
    precondition(MobileWebShellBridge.acceptsByteCount(cap - 1))
    precondition(MobileWebShellBridge.acceptsByteCount(cap))
    precondition(!MobileWebShellBridge.acceptsByteCount(cap + 1))

    // The cap is on UTF-8 bytes, not characters: a multi-byte payload must not buy extra room.
    let wide = String(repeating: "\u{1F600}", count: 4)
    precondition(wide.count == 4 && wide.utf8.count == 16)

    let gate = MobileWebShellBridgeGate()
    precondition(gate.refusedCount == 0)
    precondition(gate.accepts(byteCount: cap))
    precondition(gate.refusedCount == 0)
    precondition(!gate.accepts(byteCount: cap + 1))
    precondition(!gate.accepts(byteCount: cap * 2))
    precondition(gate.refusedCount == 2)
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
    checkAppliedProps()
    checkBridgeAcceptance()
    checkBridgePostTarget()
    checkBridgeTargetLifecycle()
    checkBridgeByteCap()
    print("mobile web shell checks OK")
  }
}
