import Foundation

// Everything the shell decides before WebKit is involved: the session id it will accept, the
// requests it will answer, the map it builds from a manifest, and the policy header. Compiled and
// run without a device:
//
//   swiftc -O -o /tmp/mobile-web-shell-checks \
//     ios/MobileWebShellOrigin.swift ios/MobileWebShellGeneration.swift ios/MobileWebShellCsp.swift \
//     ios/MobileWebShellLoadState.swift ios/MobileWebShellResponseHeaders.swift \
//     ios/MobileWebShellBridge.swift ios/MobileWebShellAppliedProps.swift \
//     ios/MobileWebShellNavigationPolicy.swift \
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
    // Reject non-ASCII letters/digits that Character accepts; IDNA must not remap the minted origin.
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
    // Unicode folding would serve assets to unminted Kelvin-sign hosts.
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
    // Only / may serve document bytes with CSP; no entrypoint alias.
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
    // NSNumber bridges JSON true and 1.0 to Int; neither satisfies the integer-1 contract.
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
    // data: previews and https: icons/srcdoc images need image-only access; see MobileWebShellCsp.
    precondition(directives.contains("img-src 'self' data: blob: https:"))
    precondition(directives.contains("connect-src 'self'"))
    precondition(directives.contains("worker-src 'none'"))
    precondition(directives.contains("frame-src 'none'"))
    precondition(directives.contains("base-uri about:"))
    precondition(directives.contains("form-action 'none'"))
    precondition(directives.contains("frame-ancestors 'none'"))
    // Inline styling must never grant inline script execution.
    precondition(directives.filter { $0.contains("unsafe-inline") } == ["style-src 'self' 'unsafe-inline'"])
    precondition(!header.contains("unsafe-eval"))
    // Only images and bundled fonts can use embedded data URLs.
    precondition(directives.filter { $0.contains("data:") } == ["img-src 'self' data: blob: https:", "font-src 'self' data:"])
    precondition(directives.filter { $0.contains("blob:") } == ["img-src 'self' data: blob: https:", "media-src blob:"])
    // Admit https: only for images; http: is not a substring and remains forbidden.
    precondition(directives.filter { $0.contains("https:") } == ["img-src 'self' data: blob: https:"])
    precondition(!header.contains("http:"))
    precondition(!header.contains("\r") && !header.contains("\n"))
  }

  static func checkLoadStateMachine() {
    let failures: [(MobileWebShellFailureReason, String)] = [
      (.generationUnreadable, "generation-unreadable"),
      (.isolationUnavailable, "isolation-unavailable"),
      (.documentLoadFailed, "document-load-failed"),
      (.renderProcessGone, "render-process-gone")
    ]
    for (reason, expected) in failures {
      let machine = MobileWebShellLoadStateMachine()
      precondition(machine.failed(reason) == MobileWebShellLoadEmission(state: "failed", reason: expected))
    }

    // Only the view’s own load raises the flag; commit, failure, renderer death and failed prop application clear it.
    let ownLoad = MobileWebShellLoadStateMachine()
    precondition(!ownLoad.isShellLoad)
    ownLoad.shellLoadStarted()
    precondition(ownLoad.isShellLoad)
    ownLoad.committed()
    precondition(!ownLoad.isShellLoad)
    ownLoad.shellLoadStarted()
    _ = ownLoad.failed(.documentLoadFailed)
    precondition(!ownLoad.isShellLoad)
    ownLoad.reset()
    ownLoad.shellLoadStarted()
    ownLoad.documentEnded()
    precondition(!ownLoad.isShellLoad)

    let progress = MobileWebShellLoadStateMachine()
    precondition(progress.started()?.state == "loading")
    precondition(progress.started() == nil)
    progress.committed()
    precondition(progress.finished()?.state == "ready")
    precondition(progress.finished() == nil)

    // replaceState rewrites the URL before finish; readiness must depend on commit state.
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
    // HTTPS images must not receive session identity; see MobileWebShellResponseHeaders.
    precondition(document["Referrer-Policy"] == "no-referrer")

    // The policy rides the document alone; on a subresource response it is inert.
    for path in ["/index.html", "/assets/aa.js", "/manifest.json", "/assets/bb.png"] {
      let headers = MobileWebShellResponseHeaders.forPath(
        path,
        contentType: "text/javascript; charset=utf-8",
        byteCount: 0
      )
      precondition(headers["Content-Security-Policy"] == nil)
      // Referrer policy governs requests only when set on the document.
      precondition(headers["Referrer-Policy"] == nil)
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
  }

  static func checkBridgeAcceptance() {
    precondition(acceptsBridge(bridgeSource()))
    // Simulator: WebKit ASCII-lowercases custom-scheme hosts; exact session comparison refuses every message.
    precondition(acceptsBridge(bridgeSource(originHost: "sess-01jn_az9")))
    precondition(acceptsBridge(bridgeSource(originHost: "SESS-01JN_AZ9")))

    // A frame we did not serve.
    precondition(!acceptsBridge(bridgeSource(originHost: "sess-01JN_aZ8")))
    precondition(!acceptsBridge(bridgeSource(originHost: "")))
    precondition(!acceptsBridge(bridgeSource(originHost: "sess-01JN_aZ9.evil")))
    // Unicode folding would accept unminted Kelvin-sign hosts.
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

    // The replaced same-origin document remains alive until the new load commits.
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

    // Never post without an accepted frame: before first message, after failure/death, or with bridge disabled.
    precondition(!canPost(nil))

    // A frame from another document, and a frame under no session at all.
    precondition(!canPost("sess-01JN_aZ8"))
    precondition(!canPost("\u{212A}ey", "key"))
    precondition(!canPost(session, ""))
    precondition(!canPost("", ""))

    // Provisional navigation invalidates the held frame until commit.
    precondition(!canPost(session, committed: false))
  }

  // A frame armed by document A must never receive posts for document B.
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

    // B’s provisional navigation clears arming and commit state.
    target.clear()
    precondition(target.frame == nil)
    precondition(!canPost(target, committed: false))

    // B’s commit rearms acceptance; clear A’s frame so it cannot become postable again.
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

    let gate = MobileWebShellBridgeGate()
    precondition(gate.refusedCount == 0)
    precondition(gate.accepts(byteCount: cap))
    precondition(gate.refusedCount == 0)
    precondition(!gate.accepts(byteCount: cap + 1))
    precondition(!gate.accepts(byteCount: cap * 2))
    precondition(gate.refusedCount == 2)
  }

  // One allow/opener decision; TypeScript’s readBridgeExternalLinkUrl owns scheme filtering.
  static func checkNavigationVerdict() {
    let foreign = "https://example.com/artifact-link"
    let document = "orca-mobile-web://\(session)/"
    func verdict(
      _ url: String? = "https://example.com/artifact-link",
      isMainFrame: Bool = true,
      isDocumentUrl: Bool = false,
      isShellLoad: Bool = false,
      hasGesture: Bool = true,
      isDownload: Bool = false
    ) -> MobileWebShellNavigationVerdict {
      MobileWebShellNavigationPolicy.verdict(
        url: url,
        isMainFrame: isMainFrame,
        isDocumentUrl: isDocumentUrl,
        isShellLoad: isShellLoad,
        hasGesture: hasGesture,
        isDownload: isDownload
      )
    }
    precondition(verdict() == .cancelAndOffer(foreign))
    // WebKit reports our own load with main-frame source and target.
    precondition(verdict(document, isDocumentUrl: true, isShellLoad: true, hasGesture: false) == .allow)
    // Never offer/reload other document-URL navigations; sandboxed top navigation can report no gesture.
    precondition(verdict(document, isDocumentUrl: true, hasGesture: false) == .cancel)
    precondition(verdict(document, isDocumentUrl: true, hasGesture: true) == .cancel)
    // Refuse non-shell document loads from page or preview frames.
    precondition(verdict(document, isDocumentUrl: true, isShellLoad: false, hasGesture: false) == .cancel)
    // A top-page meta refresh or a redirect to somewhere else: refused, and never opened.
    precondition(verdict(hasGesture: false) == .cancel)
    // Gestured downloads reach the opener, never the document-load allowance.
    precondition(
      verdict(document, isDocumentUrl: true, isShellLoad: true, hasGesture: false, isDownload: true)
        == .cancel
    )
    precondition(verdict(isDownload: true) == .cancelAndOffer(foreign))
    // Document-URL downloads are never offered, regardless of gesture.
    precondition(verdict(document, isDocumentUrl: true, isDownload: true) == .cancel)
    // A subframe is the sealed preview loading itself, which is not the user leaving the app.
    precondition(verdict(isMainFrame: false) == .cancel)
    precondition(verdict(isMainFrame: false, hasGesture: false) == .cancel)
    precondition(verdict(nil) == .cancel)
    precondition(verdict("") == .cancel)
    // The crossing cap, at it and one past it.
    let cap = MobileWebShellNavigationPolicy.maxCancelledNavigationUrlCharacters
    let prefix = "https://example.com/"
    let atCap = prefix + String(repeating: "a", count: cap - prefix.count)
    precondition(atCap.count == cap)
    precondition(MobileWebShellNavigationPolicy.offerableUrl(atCap) == atCap)
    precondition(MobileWebShellNavigationPolicy.offerableUrl(atCap + "a") == nil)
    precondition(verdict(atCap + "a") == .cancel)
    // A scheme the opener will refuse still crosses: one filter, in the half that updates.
    precondition(verdict("javascript:alert(1)") == .cancelAndOffer("javascript:alert(1)"))
  }

  // Check flag/policy together: only one main-frame action may spend the shell’s own-load allowance.
  static func checkOwnLoadIsSpentOnce() {
    let document = "orca-mobile-web://\(session)/"
    func decide(_ machine: MobileWebShellLoadStateMachine) -> MobileWebShellNavigationVerdict {
      MobileWebShellNavigationPolicy.verdict(
        url: document,
        isMainFrame: true,
        isDocumentUrl: true,
        isShellLoad: machine.isShellLoad,
        hasGesture: false,
        isDownload: false
      )
    }
    let machine = MobileWebShellLoadStateMachine()
    machine.shellLoadStarted()
    let first = decide(machine)
    precondition(first == .allow)
    // Spend at decision, before commit: WebKit may decide a second action first.
    machine.shellLoadConsumed()
    precondition(decide(machine) == .cancel)
    // And the endings still drop it, for a load that is allowed and then never commits.
    machine.shellLoadStarted()
    machine.documentEnded()
    precondition(decide(machine) == .cancel)
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
    checkNavigationVerdict()
    checkOwnLoadIsSpentOnce()
    checkAppliedProps()
    checkBridgeAcceptance()
    checkBridgePostTarget()
    checkBridgeTargetLifecycle()
    checkBridgeByteCap()
    print("mobile web shell checks OK")
  }
}
