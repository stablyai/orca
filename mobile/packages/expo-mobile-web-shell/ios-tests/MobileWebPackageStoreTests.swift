import Foundation

@main
enum MobileWebPackageStoreTests {
  static func main() throws {
    if try MobileWebPackageStoreProcessInterruptionTests.runIfChild() {
      return
    }
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("orca-mobile-web-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }

    try commitsAndReadsExactGeneration(root: root.appendingPathComponent("verified"))
    try commitsAllPackagedDocuments(root: root.appendingPathComponent("all-documents"))
    try rejectsMalformedManifests(root: root.appendingPathComponent("manifests"))
    acceptsOnlyExactCanonicalAssetPaths()
    acceptsOnlyExactSha256Tokens()
    acceptsOnlyExactAssetMetadata()
    try rejectsQuotedNumericManifestFields(root: root.appendingPathComponent("scalar-types"))
    try rejectsBooleanNumericManifestFields(root: root.appendingPathComponent("boolean-types"))
    try rejectsOversizedManifestInput(root: root.appendingPathComponent("manifest-limit"))
    try dropsStagedTreesOnRestart(root: root.appendingPathComponent("interrupted"))
    try rejectsOversizedEncodedAssets(root: root.appendingPathComponent("asset-limit"))
    try rejectsIncompleteAndCorruptGeneration(root: root.appendingPathComponent("corrupt"))
    try repairsRedownloadedGeneration(root: root.appendingPathComponent("repair"))
    try rejectsOversizedPersistedFiles(root: root.appendingPathComponent("persisted-limits"))
    try keepsOnlyTheCommittedGeneration(root: root.appendingPathComponent("single-generation"))
    try abortsStagedGeneration(root: root.appendingPathComponent("abort"))
    try evictsLeastRecentlyActivatedHost(root: root.appendingPathComponent("host-cap"))
    try removesOnlySelectedHost(root: root.appendingPathComponent("remove-host"))
    try MobileWebCacheFileBoundaryTests.run(
      root: root.appendingPathComponent("cache-file-boundary")
    )
    try MobileWebCacheCleanupBoundaryTests.run(
      root: root.appendingPathComponent("cache-cleanup-boundary")
    )
    try MobileWebCacheWriteBoundaryTests.run(
      root: root.appendingPathComponent("cache-write-boundary")
    )
    try MobileWebHostRootBoundaryTests.run(
      root: root.appendingPathComponent("host-root-boundary")
    )
    try MobileWebPackageStoreGeneratedMutationTests.run(
      root: root.appendingPathComponent("generated-mutation")
    )
    try MobileWebPackageStoreConcurrencyTests.run(
      root: root.appendingPathComponent("concurrency")
    )
    try MobileWebPackageStoreProcessInterruptionTests.verify(
      root: root.appendingPathComponent("process-interruption")
    )
  }

  private static func commitsAndReadsExactGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    try mobileWebStoreCommit(store: store, host: "paired-host", fixture: fixture)
    let session = try store.openSession(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    let asset = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
    precondition(session["buildId"] == fixture.buildId)
    precondition(asset.contentType == "text/html; charset=utf-8")
    precondition(asset.data == fixture.bytes)
    let active = try store.openSession(
      hostIdentity: "paired-host",
      buildId: nil,
      bridgeVersion: 1
    )
    precondition(active["buildId"] == fixture.buildId)
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: "different-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
    precondition(
      mobileWebStoreThrowsCode("mobile_web_bridge_incompatible") {
        _ = try store.openSession(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          bridgeVersion: 2
        )
      }
    )
    // The staged tree never survives its own commit.
    let staging = mobileWebStoreHostRoot(cacheRoot: root, host: "paired-host")
      .appendingPathComponent("tmp")
    let staged = try? FileManager.default.contentsOfDirectory(atPath: staging.path)
    precondition(staged?.isEmpty != false)
  }

  private static func commitsAllPackagedDocuments(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let paths = ["index.html", "markdown-editor.html", "mermaid-frame.html"]
    let fixture = try mobileWebStoreFixture { manifest in
      let asset = (manifest["assets"] as! [[String: Any]])[0]
      manifest["assets"] = paths.map { path in
        var document = asset
        document["path"] = path
        return document
      }
      manifest["totalBytes"] = (manifest["totalBytes"] as! Int) * paths.count
    }
    for path in paths {
      try store.writeStagedAsset(
        hostIdentity: "paired-host", buildId: fixture.buildId, path: path,
        dataBase64: fixture.bytes.base64EncodedString()
      )
    }
    try store.commitGeneration(
      hostIdentity: "paired-host", buildId: fixture.buildId, manifestJson: fixture.manifestJson
    )
    let session = try store.openSession(
      hostIdentity: "paired-host", buildId: fixture.buildId, bridgeVersion: 1
    )
    for path in paths {
      let asset = try store.readAsset(sessionId: session["sessionId"]!, path: path)
      precondition(asset.data == fixture.bytes && asset.isDocument)
    }
  }

  private static func rejectsMalformedManifests(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let valid = try mobileWebStoreFixture()
    let invalid = [
      // The build id names these exact bytes, so a reserialization no longer matches it.
      MobileWebStoreFixture(
        bytes: valid.bytes,
        manifestJson: valid.manifestJson + " ",
        buildId: valid.buildId
      ),
      MobileWebStoreFixture(
        bytes: valid.bytes,
        manifestJson: valid.manifestJson,
        buildId: String(repeating: "a", count: 64)
      ),
      MobileWebStoreFixture(
        bytes: valid.bytes,
        manifestJson: valid.manifestJson,
        buildId: "not-a-hash"
      ),
      // A build id key inside the canonical document is an unknown field.
      mobileWebStoreFixtureRebuilt(
        from: valid,
        manifestJson: String(valid.manifestJson.dropLast()) + ",\"buildId\":\"\(valid.buildId)\"}"
      ),
      try mobileWebStoreFixture { $0["schemaVersion"] = 2 },
      try mobileWebStoreFixture { manifest in
        mobileWebStoreMutateAsset(&manifest) { $0["path"] = "../index.html" }
      },
      try mobileWebStoreFixture { manifest in
        mobileWebStoreMutateAsset(&manifest) { $0["contentType"] = "application/octet-stream" }
      },
      try mobileWebStoreFixture { $0["totalBytes"] = valid.bytes.count + 1 },
      try mobileWebStoreFixture { $0["entrypoint"] = "other.html" },
      try mobileWebStoreFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["minimum"] = 2
        manifest["bridge"] = bridge
      },
    ]
    for fixture in invalid {
      precondition(
        mobileWebStoreThrows {
          _ = try store.commitGeneration(
            hostIdentity: "paired-host",
            buildId: fixture.buildId,
            manifestJson: fixture.manifestJson
          )
        }
      )
    }
  }

  private static func acceptsOnlyExactCanonicalAssetPaths() {
    let invalid = [
      "",
      "../index.html",
      "./index.html",
      "/index.html",
      "index.html/",
      "assets//app.js",
      "assets\\app.js",
      "assets/app.js?query",
      "assets/app.js#fragment",
      "assets/%2e%2e/app.js",
      "assets/./app.js",
      "assets/../app.js",
      "assets/app.js\n",
      String(repeating: "a", count: 241),
      "assets/café.js",
    ]
    let valid = [
      "index.html",
      "assets/\(String(repeating: "a", count: 64)).js",
      "assets/a_b-c.d.js",
    ]

    precondition(invalid.allSatisfy { !isSafeMobileWebAssetPath($0) })
    precondition(valid.allSatisfy(isSafeMobileWebAssetPath))
  }

  private static func acceptsOnlyExactSha256Tokens() {
    let invalid = [
      "",
      String(repeating: "a", count: 63),
      String(repeating: "a", count: 65),
      "\(String(repeating: "a", count: 64))\n",
      String(repeating: "A", count: 64),
    ]

    precondition(invalid.allSatisfy { !isMobileWebSha256($0) })
    precondition(isMobileWebSha256(String(repeating: "a", count: 64)))
  }

  private static func acceptsOnlyExactAssetMetadata() {
    let hash = String(repeating: "a", count: 64)
    let valid = [
      ("index.html", hash, "text/html; charset=utf-8", "document"),
      ("mermaid-frame.html", hash, "text/html; charset=utf-8", "document"),
      ("markdown-editor.html", hash, "text/html; charset=utf-8", "document"),
      ("assets/\(hash).css", hash, "text/css; charset=utf-8", "style"),
      ("assets/\(hash).js", hash, "text/javascript; charset=utf-8", "script"),
      ("assets/\(hash).png", hash, "image/png", "image"),
      ("assets/\(hash).svg", hash, "image/svg+xml; charset=utf-8", "image"),
      ("assets/\(hash).wasm", hash, "application/wasm", "wasm"),
      ("assets/\(hash).webp", hash, "image/webp", "image"),
      ("assets/\(hash).woff2", hash, "font/woff2", "font"),
    ]
    let invalid = [
      ("assets/\(hash).js", hash, "text/css; charset=utf-8", "script"),
      ("assets/\(hash).js", hash, "text/javascript; charset=utf-8", "style"),
      ("assets/\(hash).png", hash, "image/png; charset=utf-8", "image"),
      ("assets/\(hash).JS", hash, "text/javascript; charset=utf-8", "script"),
      ("assets/\(hash).txt", hash, "text/plain; charset=utf-8", "document"),
      ("other-frame.html", hash, "text/html; charset=utf-8", "document"),
      (
        "assets/\(hash).js",
        String(repeating: "b", count: 64),
        "text/javascript; charset=utf-8",
        "script"
      ),
      ("index.html", hash, "text/html; charset=UTF-8", "document"),
      ("index.html", hash, "text/html; charset=utf-8", "document "),
    ]

    precondition(
      valid.allSatisfy {
        isValidMobileWebAssetMetadata(path: $0.0, hash: $0.1, contentType: $0.2, role: $0.3)
      }
    )
    precondition(
      invalid.allSatisfy {
        !isValidMobileWebAssetMetadata(path: $0.0, hash: $0.1, contentType: $0.2, role: $0.3)
      }
    )
  }

  private static func rejectsQuotedNumericManifestFields(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let valid = try mobileWebStoreFixture()
    let invalid = [
      try mobileWebStoreFixture { $0["schemaVersion"] = "1" },
      try mobileWebStoreFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["minimum"] = "1"
        manifest["bridge"] = bridge
      },
      try mobileWebStoreFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["testedThrough"] = "1"
        manifest["bridge"] = bridge
      },
      try mobileWebStoreFixture { $0["totalBytes"] = String(valid.bytes.count) },
      try mobileWebStoreFixture { manifest in
        mobileWebStoreMutateAsset(&manifest) { $0["byteLength"] = String(valid.bytes.count) }
      },
    ]
    for fixture in invalid {
      precondition(
        mobileWebStoreThrowsCode("mobile_web_manifest_invalid") {
          _ = try store.commitGeneration(
            hostIdentity: "paired-host",
            buildId: fixture.buildId,
            manifestJson: fixture.manifestJson
          )
        }
      )
    }
  }

  private static func rejectsBooleanNumericManifestFields(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let invalid = [
      try mobileWebStoreFixture { $0["schemaVersion"] = true },
      try mobileWebStoreFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["minimum"] = true
        manifest["bridge"] = bridge
      },
      try mobileWebStoreFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["testedThrough"] = true
        manifest["bridge"] = bridge
      },
      try mobileWebStoreFixture { $0["totalBytes"] = true },
      try mobileWebStoreFixture { manifest in
        mobileWebStoreMutateAsset(&manifest) { $0["byteLength"] = true }
      },
    ]
    for fixture in invalid {
      precondition(
        mobileWebStoreThrowsCode("mobile_web_manifest_invalid") {
          _ = try store.commitGeneration(
            hostIdentity: "paired-host",
            buildId: fixture.buildId,
            manifestJson: fixture.manifestJson
          )
        }
      )
    }
  }

  private static func rejectsOversizedManifestInput(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let oversized = String(repeating: " ", count: 256 * 1024 + 1)
    precondition(
      mobileWebStoreThrowsCode("mobile_web_manifest_invalid") {
        _ = try store.commitGeneration(
          hostIdentity: "paired-host",
          buildId: mobileWebStoreSha256Hex(Data(oversized.utf8)),
          manifestJson: oversized
        )
      }
    )
  }

  private static func dropsStagedTreesOnRestart(root: URL) throws {
    let first = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    try mobileWebStoreStageAsset(store: first, host: "paired-host", fixture: fixture)
    let staging = mobileWebStoreHostRoot(cacheRoot: root, host: "paired-host")
      .appendingPathComponent("tmp")
    let stagedBefore = try FileManager.default.contentsOfDirectory(atPath: staging.path)
    precondition(stagedBefore.count == 1)

    _ = MobileWebPackageStore(cacheRoot: root)

    precondition(!FileManager.default.fileExists(atPath: staging.path))
    // A commit that lost its staged bytes must not publish a generation.
    precondition(
      mobileWebStoreThrowsCode("mobile_web_staged_generation_incomplete") {
        _ = try first.commitGeneration(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          manifestJson: fixture.manifestJson
        )
      }
    )
  }

  private static func rejectsOversizedEncodedAssets(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    let invalid: [(String, String)] = [
      ("index.html", String(repeating: "A", count: 14 * 1024 * 1024)),
      ("index.html", "not base64!"),
      ("index.html", ""),
      ("../escape.html", fixture.bytes.base64EncodedString()),
      ("manifest.json", fixture.bytes.base64EncodedString()),
    ]
    for (path, dataBase64) in invalid {
      precondition(
        mobileWebStoreThrowsCode("mobile_web_staged_asset_invalid") {
          try store.writeStagedAsset(
            hostIdentity: "paired-host",
            buildId: fixture.buildId,
            path: path,
            dataBase64: dataBase64
          )
        }
      )
    }
    precondition(
      mobileWebStoreThrowsCode("mobile_web_staged_asset_invalid") {
        try store.writeStagedAsset(
          hostIdentity: "paired-host",
          buildId: "not-a-build-id",
          path: "index.html",
          dataBase64: fixture.bytes.base64EncodedString()
        )
      }
    )
  }

  private static func rejectsIncompleteAndCorruptGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    precondition(
      mobileWebStoreThrowsCode("mobile_web_staged_generation_incomplete") {
        _ = try store.commitGeneration(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          manifestJson: fixture.manifestJson
        )
      }
    )
    // Anything the manifest does not name would ride the rename into the generation.
    try store.writeStagedAsset(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      path: "index.html",
      dataBase64: fixture.bytes.base64EncodedString()
    )
    try store.writeStagedAsset(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      path: "assets/extra.js",
      dataBase64: fixture.bytes.base64EncodedString()
    )
    precondition(
      mobileWebStoreThrowsCode("mobile_web_staged_generation_incomplete") {
        _ = try store.commitGeneration(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          manifestJson: fixture.manifestJson
        )
      }
    )
    store.abortGeneration(hostIdentity: "paired-host", buildId: fixture.buildId)

    try mobileWebStoreCommit(store: store, host: "paired-host", fixture: fixture)
    let session = try store.openSession(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    let document = mobileWebStoreGenerationRoot(
      cacheRoot: root,
      host: "paired-host",
      buildId: fixture.buildId
    ).appendingPathComponent("index.html")
    try Data("corrupt".utf8).write(to: document)
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
      }
    )
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
  }

  private static func repairsRedownloadedGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    try mobileWebStoreCommit(store: store, host: "paired-host", fixture: fixture)
    let generation = mobileWebStoreGenerationRoot(
      cacheRoot: root,
      host: "paired-host",
      buildId: fixture.buildId
    )
    for path in ["index.html", "manifest.json"] {
      try Data("corrupt".utf8).write(to: generation.appendingPathComponent(path))
      precondition(
        mobileWebStoreThrows {
          _ = try store.openSession(hostIdentity: "paired-host", buildId: nil, bridgeVersion: 1)
        }
      )
      try mobileWebStoreCommit(store: store, host: "paired-host", fixture: fixture)
      let restored = try store.openSession(
        hostIdentity: "paired-host",
        buildId: nil,
        bridgeVersion: 1
      )
      let asset = try store.readAsset(sessionId: restored["sessionId"]!, path: "index.html")
      precondition(asset.data == fixture.bytes)
      store.closeSession(sessionId: restored["sessionId"]!)
    }
  }

  private static func rejectsOversizedPersistedFiles(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    try mobileWebStoreCommit(store: store, host: "paired-host", fixture: fixture)
    let session = try store.openSession(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    let generationRoot = mobileWebStoreGenerationRoot(
      cacheRoot: root,
      host: "paired-host",
      buildId: fixture.buildId
    )
    let manifest = generationRoot.appendingPathComponent("manifest.json")
    let document = generationRoot.appendingPathComponent("index.html")

    try Data(repeating: 0x20, count: 256 * 1024 + 1).write(to: manifest)
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
    try Data(fixture.manifestJson.utf8).write(to: manifest)

    try Data(repeating: 0, count: fixture.bytes.count + 1).write(to: document)
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
      }
    )
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
  }

  private static func keepsOnlyTheCommittedGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let previous = try mobileWebStoreFixture(content: "<!doctype html><title>Previous</title>")
    let current = try mobileWebStoreFixture(content: "<!doctype html><title>Current</title>")
    try mobileWebStoreCommit(store: store, host: "paired-host", fixture: previous)
    let previousSession = try store.openSession(
      hostIdentity: "paired-host",
      buildId: previous.buildId,
      bridgeVersion: 1
    )
    try mobileWebStoreCommit(store: store, host: "paired-host", fixture: current)

    // A session that is still serving its generation keeps it until it closes.
    let live = try store.readAsset(sessionId: previousSession["sessionId"]!, path: "index.html")
    precondition(live.data == previous.bytes)
    let active = try store.openSession(hostIdentity: "paired-host", buildId: nil, bridgeVersion: 1)
    precondition(active["buildId"] == current.buildId)

    store.closeSession(sessionId: previousSession["sessionId"]!)
    store.closeSession(sessionId: active["sessionId"]!)

    let generations = mobileWebStoreHostRoot(cacheRoot: root, host: "paired-host")
      .appendingPathComponent("generations")
    let remaining = try FileManager.default.contentsOfDirectory(atPath: generations.path)
    precondition(remaining == [current.buildId])
  }

  private static func abortsStagedGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    try mobileWebStoreStageAsset(store: store, host: "paired-host", fixture: fixture)
    let staged = mobileWebStoreStagingRoot(
      cacheRoot: root,
      host: "paired-host",
      buildId: fixture.buildId
    )
    precondition(FileManager.default.fileExists(atPath: staged.path))

    store.abortGeneration(hostIdentity: "paired-host", buildId: fixture.buildId)

    precondition(!FileManager.default.fileExists(atPath: staged.path))
    precondition(
      mobileWebStoreThrowsCode("mobile_web_staged_generation_incomplete") {
        _ = try store.commitGeneration(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          manifestJson: fixture.manifestJson
        )
      }
    )
  }

  private static func evictsLeastRecentlyActivatedHost(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let hosts = (0..<5).map { "cap-host-\($0)" }
    var fixtures = [String: MobileWebStoreFixture]()
    for (index, host) in hosts.enumerated() {
      let fixture = try mobileWebStoreFixture(content: "<!doctype html><title>\(index)</title>")
      fixtures[host] = fixture
      try mobileWebStoreCommit(store: store, host: host, fixture: fixture)
      let session = try store.openSession(hostIdentity: host, buildId: nil, bridgeVersion: 1)
      store.closeSession(sessionId: session["sessionId"]!)
      // The eviction order is the activation order, which is the host root's modification time.
      try FileManager.default.setAttributes(
        [.modificationDate: Date(timeIntervalSince1970: Double(1_000 + index))],
        ofItemAtPath: mobileWebStoreHostRoot(cacheRoot: root, host: host).path
      )
    }
    // Committing again re-applies the cap now that the activation times are ordered.
    try mobileWebStoreCommit(store: store, host: hosts[4], fixture: fixtures[hosts[4]]!)

    precondition(
      !FileManager.default.fileExists(
        atPath: mobileWebStoreHostRoot(cacheRoot: root, host: hosts[0]).path
      )
    )
    for host in hosts.dropFirst() {
      let session = try store.openSession(hostIdentity: host, buildId: nil, bridgeVersion: 1)
      let asset = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
      precondition(asset.data == fixtures[host]!.bytes)
      store.closeSession(sessionId: session["sessionId"]!)
    }
  }

  private static func removesOnlySelectedHost(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let removed = try mobileWebStoreFixture(content: "<!doctype html><title>Removed</title>")
    let retained = try mobileWebStoreFixture(content: "<!doctype html><title>Retained</title>")
    try mobileWebStoreCommit(store: store, host: "removed-host", fixture: removed)
    try mobileWebStoreCommit(store: store, host: "retained-host", fixture: retained)
    let removedSession = try store.openSession(
      hostIdentity: "removed-host",
      buildId: removed.buildId,
      bridgeVersion: 1
    )
    let retainedSession = try store.openSession(
      hostIdentity: "retained-host",
      buildId: retained.buildId,
      bridgeVersion: 1
    )
    try mobileWebStoreStageAsset(store: store, host: "removed-host", fixture: removed)

    try store.removeHost(hostIdentity: "removed-host")

    precondition(
      !FileManager.default.fileExists(
        atPath: mobileWebStoreHostRoot(cacheRoot: root, host: "removed-host").path
      )
    )
    precondition(
      mobileWebStoreThrowsCode("mobile_web_asset_unavailable") {
        _ = try store.readAsset(sessionId: removedSession["sessionId"]!, path: "index.html")
      }
    )
    let asset = try store.readAsset(sessionId: retainedSession["sessionId"]!, path: "index.html")
    precondition(asset.data == retained.bytes)
  }
}
