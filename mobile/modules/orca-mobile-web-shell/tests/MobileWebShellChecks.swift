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


  static func checkGenerationMap() {
    guard let built = generation(manifest()) else { preconditionFailure("manifest rejected") }
    // Only / may serve document bytes with CSP; no entrypoint alias.
    precondition(built.entries["/index.html"] == nil)

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
    precondition(generation(Data(#"{"schemaVersion":"1","entrypoint":"index.html","assets":[{"path":"index.html","contentType":"text/html"}]}"#.utf8)) == nil)
    precondition(generation(Data("not json".utf8)) == nil)
    precondition(generation(Data("[]".utf8)) == nil)
  }


  static func checkLoadStateMachine() {
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



  static func main() {
    checkGenerationMap()
    checkLoadStateMachine()
    print("mobile web shell checks OK")
  }
}
