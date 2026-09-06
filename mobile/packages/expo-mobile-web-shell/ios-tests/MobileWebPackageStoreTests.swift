import CryptoKit
import Foundation

@main
enum MobileWebPackageStoreTests {
  static func main() throws {
    if try MobileWebPackageStoreProcessInterruptionTests.runIfChild() {
      return
    }
    MobileWebExactJsonTests.run()
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("orca-mobile-web-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }

    try stagesAndReadsExactGeneration(root: root.appendingPathComponent("verified"))
    try rejectsMalformedManifests(root: root.appendingPathComponent("manifests"))
    acceptsOnlyExactCanonicalAssetPaths()
    acceptsOnlyExactSha256Tokens()
    acceptsOnlyExactAssetMetadata()
    try rejectsQuotedNumericManifestFields(root: root.appendingPathComponent("scalar-types"))
    try rejectsBooleanNumericManifestFields(root: root.appendingPathComponent("boolean-types"))
    try rejectsOversizedManifestInput(root: root.appendingPathComponent("manifest-limit"))
    try deletesInterruptedStage(root: root.appendingPathComponent("interrupted"))
    try rejectsOversizedEncodedChunks(root: root.appendingPathComponent("chunk-limit"))
    try rejectsIncompleteAndCorruptGeneration(root: root.appendingPathComponent("corrupt"))
    try repairsRedownloadedGeneration(root: root.appendingPathComponent("repair"))
    try rejectsOversizedPersistedFiles(root: root.appendingPathComponent("persisted-limits"))
    try activatesAndRecoversPreviousGeneration(root: root.appendingPathComponent("rollback"))
    try fallsBackFromCorruptActiveGeneration(root: root.appendingPathComponent("corrupt-active"))
    try MobileWebActivationMetadataTests.run(
      root: root.appendingPathComponent("activation-types")
    )
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
    try rejectsLowStorage(root: root.appendingPathComponent("low-storage"))
    try evictsUnprotectedGeneration(root: root.appendingPathComponent("eviction"))
    try evictsAnotherHostForGlobalQuota(root: root.appendingPathComponent("global-eviction"))
    try removesOnlySelectedHost(root: root.appendingPathComponent("remove-host"))
    try MobileWebPackageStoreProcessInterruptionTests.verify(
      root: root.appendingPathComponent("process-interruption"),
    )
  }

  private static func stagesAndReadsExactGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try packageFixture()
    try stagePackage(store: store, host: "paired-host", fixture: fixture)
    let session = try store.openSession(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    let asset = try store.readAsset(
      sessionId: session["sessionId"]!,
      path: "index.html"
    )
    precondition(session["buildId"] == fixture.buildId)
    precondition(asset.contentType == "text/html; charset=utf-8")
    precondition(asset.data == fixture.bytes)
    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: "different-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
  }

  private static func rejectsMalformedManifests(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let valid = try packageFixture()
    let duplicateCanonical = String(valid.canonical.dropLast()) + ",\"schemaVersion\":1}"
    let duplicateBuildId = sha256Hex(Data(duplicateCanonical.utf8))
    var duplicateManifest =
      try JSONSerialization.jsonObject(
        with: Data(valid.manifest.utf8)
      ) as! [String: Any]
    duplicateManifest["buildId"] = duplicateBuildId
    let duplicateManifestJson = String(
      decoding: try JSONSerialization.data(
        withJSONObject: duplicateManifest, options: [.sortedKeys]),
      as: UTF8.self
    )
    let invalid = [
      PackageFixture(
        bytes: valid.bytes,
        canonical: valid.canonical + " ",
        manifest: valid.manifest,
        buildId: valid.buildId
      ),
      PackageFixture(
        bytes: valid.bytes,
        canonical: valid.canonical,
        manifest: valid.manifest + " trailing",
        buildId: valid.buildId
      ),
      PackageFixture(
        bytes: valid.bytes,
        canonical: valid.canonical,
        manifest: valid.manifest.dropLast() + ",\"schemaVersion\":1}",
        buildId: valid.buildId
      ),
      PackageFixture(
        bytes: valid.bytes,
        canonical: duplicateCanonical,
        manifest: duplicateManifestJson,
        buildId: duplicateBuildId
      ),
      try packageFixture { manifest in
        mutateAsset(&manifest) { $0["path"] = "../index.html" }
      },
      try packageFixture { manifest in
        mutateAsset(&manifest) { $0["contentType"] = "application/octet-stream" }
      },
      try packageFixture { manifest in
        manifest["totalBytes"] = valid.bytes.count + 1
      },
    ]
    for fixture in invalid {
      precondition(
        throwsError {
          _ = try store.beginStage(
            hostIdentity: "paired-host",
            manifestJson: fixture.manifest,
            canonicalManifestJson: fixture.canonical
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
        isValidMobileWebAssetMetadata(
          path: $0.0,
          hash: $0.1,
          contentType: $0.2,
          role: $0.3
        )
      }
    )
    precondition(
      invalid.allSatisfy {
        !isValidMobileWebAssetMetadata(
          path: $0.0,
          hash: $0.1,
          contentType: $0.2,
          role: $0.3
        )
      }
    )
  }

  private static func rejectsQuotedNumericManifestFields(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let valid = try packageFixture()
    let invalid = [
      try packageFixture { $0["schemaVersion"] = "1" },
      try packageFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["minimum"] = "1"
        manifest["bridge"] = bridge
      },
      try packageFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["testedThrough"] = "1"
        manifest["bridge"] = bridge
      },
      try packageFixture { $0["totalBytes"] = String(valid.bytes.count) },
      try packageFixture { manifest in
        mutateAsset(&manifest) { $0["byteLength"] = String(valid.bytes.count) }
      },
    ]
    for fixture in invalid {
      precondition(
        throwsError {
          _ = try store.beginStage(
            hostIdentity: "paired-host",
            manifestJson: fixture.manifest,
            canonicalManifestJson: fixture.canonical
          )
        }
      )
    }
  }

  private static func rejectsBooleanNumericManifestFields(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let invalid = [
      try packageFixture { $0["schemaVersion"] = true },
      try packageFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["minimum"] = true
        manifest["bridge"] = bridge
      },
      try packageFixture { manifest in
        var bridge = manifest["bridge"] as! [String: Any]
        bridge["testedThrough"] = true
        manifest["bridge"] = bridge
      },
      try packageFixture { $0["totalBytes"] = true },
      try packageFixture { manifest in
        mutateAsset(&manifest) { $0["byteLength"] = true }
      },
    ]
    for fixture in invalid {
      precondition(
        throwsError {
          _ = try store.beginStage(
            hostIdentity: "paired-host",
            manifestJson: fixture.manifest,
            canonicalManifestJson: fixture.canonical
          )
        }
      )
    }
  }

  private static func rejectsOversizedManifestInput(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try packageFixture()
    let oversized = String(repeating: " ", count: 256 * 1024 + 1)
    let invalid = [
      (oversized, fixture.canonical),
      (fixture.manifest, oversized),
    ]

    for (manifest, canonical) in invalid {
      precondition(
        throwsCode("mobile_web_stage_manifest_invalid") {
          _ = try store.beginStage(
            hostIdentity: "paired-host",
            manifestJson: manifest,
            canonicalManifestJson: canonical
          )
        }
      )
    }
  }

  private static func deletesInterruptedStage(root: URL) throws {
    let first = MobileWebPackageStore(cacheRoot: root)
    let fixture = try packageFixture()
    let stageId = try first.beginStage(
      hostIdentity: "paired-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )
    let staging =
      root
      .appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
      .appendingPathComponent("staging")
    let stagedBeforeRestart = try FileManager.default.contentsOfDirectory(atPath: staging.path)
    precondition(stagedBeforeRestart.count == 1)

    _ = MobileWebPackageStore(cacheRoot: root)

    let stagedAfterRestart = try FileManager.default.contentsOfDirectory(atPath: staging.path)
    precondition(stagedAfterRestart.isEmpty)
    precondition(
      throwsError {
        try first.writeAssetChunk(
          stageId: stageId,
          path: "index.html",
          offset: 0,
          dataBase64: fixture.bytes.base64EncodedString(),
          chunkSha256: sha256Hex(fixture.bytes)
        )
      }
    )
  }

  private static func rejectsOversizedEncodedChunks(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try packageFixture()
    let stageId = try store.beginStage(
      hostIdentity: "paired-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )

    precondition(
      throwsCode("mobile_web_stage_chunk_invalid") {
        try store.writeAssetChunk(
          stageId: stageId,
          path: "index.html",
          offset: 0,
          dataBase64: String(repeating: "A", count: 65_537),
          chunkSha256: sha256Hex(fixture.bytes)
        )
      }
    )
    store.abortStage(stageId: stageId)
  }

  private static func rejectsIncompleteAndCorruptGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try packageFixture()
    let incomplete = try store.beginStage(
      hostIdentity: "paired-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )
    precondition(throwsError { _ = try store.commitStage(stageId: incomplete) })
    store.abortStage(stageId: incomplete)
    try stagePackage(store: store, host: "paired-host", fixture: fixture)
    let session = try store.openSession(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    let document =
      root
      .appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
      .appendingPathComponent("generations")
      .appendingPathComponent(fixture.buildId)
      .appendingPathComponent("index.html")
    try Data("corrupt".utf8).write(to: document)
    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
      }
    )
    precondition(
      throwsCode("mobile_web_generation_invalid") {
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
    let fixture = try packageFixture()
    try stagePackage(store: store, host: "paired-host", fixture: fixture)
    let session = try store.openSession(
      hostIdentity: "paired-host", buildId: fixture.buildId, bridgeVersion: 1
    )
    _ = try store.markSessionHealthy(sessionId: session["sessionId"]!)
    let generation = root
      .appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
      .appendingPathComponent("generations")
      .appendingPathComponent(fixture.buildId)
    for path in ["index.html", "manifest.json", "canonical-manifest.json"] {
      try Data("corrupt".utf8).write(to: generation.appendingPathComponent(path))
      precondition(throwsError {
        _ = try store.openSession(
          hostIdentity: "paired-host", buildId: nil, bridgeVersion: 1
        )
      })
      try stagePackage(store: store, host: "paired-host", fixture: fixture)
      let restored = try store.openSession(
        hostIdentity: "paired-host", buildId: nil, bridgeVersion: 1
      )
      let asset = try store.readAsset(sessionId: restored["sessionId"]!, path: "index.html")
      precondition(asset.data == fixture.bytes)
      let liveAsset = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
      precondition(liveAsset.data == fixture.bytes)
      store.closeSession(sessionId: restored["sessionId"]!)
    }
  }

  private static func rejectsOversizedPersistedFiles(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try packageFixture()
    try stagePackage(store: store, host: "paired-host", fixture: fixture)
    let session = try store.openSession(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    _ = try store.markSessionHealthy(sessionId: session["sessionId"]!)
    let hostRoot = root.appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
    let generationRoot =
      hostRoot
      .appendingPathComponent("generations")
      .appendingPathComponent(fixture.buildId)
    let manifest = generationRoot.appendingPathComponent("manifest.json")
    let canonicalManifest = generationRoot.appendingPathComponent("canonical-manifest.json")
    let document = generationRoot.appendingPathComponent("index.html")

    try Data(repeating: 0x20, count: 256 * 1024 + 1).write(to: manifest)
    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
    try Data(fixture.manifest.utf8).write(to: manifest)

    try Data(repeating: 0x20, count: 256 * 1024 + 1).write(to: canonicalManifest)
    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
    try Data(fixture.canonical.utf8).write(to: canonicalManifest)

    try Data(repeating: 0, count: fixture.bytes.count + 1).write(to: document)
    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
      }
    )
    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )

    try Data(repeating: 0x20, count: 1025).write(
      to: hostRoot.appendingPathComponent("activation.json")
    )
    precondition(
      throwsCode("mobile_web_activation_invalid") {
        _ = try store.openSession(
          hostIdentity: "paired-host",
          buildId: nil,
          bridgeVersion: 1
        )
      }
    )
  }

  private static func activatesAndRecoversPreviousGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let previous = try packageFixture(content: "<!doctype html><title>Previous</title>")
    let current = try packageFixture(content: "<!doctype html><title>Current</title>")
    try stagePackage(store: store, host: "paired-host", fixture: previous)
    let previousSession = try store.openSession(
      hostIdentity: "paired-host",
      buildId: previous.buildId,
      bridgeVersion: 1
    )
    let previousActivation = try store.markSessionHealthy(
      sessionId: previousSession["sessionId"]!
    )
    precondition(previousActivation == previous.buildId)
    try stagePackage(store: store, host: "paired-host", fixture: current)
    let currentSession = try store.openSession(
      hostIdentity: "paired-host",
      buildId: current.buildId,
      bridgeVersion: 1
    )
    let currentActivation = try store.markSessionHealthy(
      sessionId: currentSession["sessionId"]!
    )
    precondition(currentActivation == current.buildId)

    let recovered = try store.recoverSession(sessionId: currentSession["sessionId"]!)
    precondition(recovered["buildId"] == previous.buildId)
    let active = try store.openSession(
      hostIdentity: "paired-host",
      buildId: nil,
      bridgeVersion: 1
    )
    precondition(active["buildId"] == previous.buildId)
  }

  private static func fallsBackFromCorruptActiveGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let previous = try packageFixture(content: "<!doctype html><title>Previous</title>")
    let current = try packageFixture(content: "<!doctype html><title>Current</title>")
    try stagePackage(store: store, host: "paired-host", fixture: previous)
    let previousSession = try store.openSession(
      hostIdentity: "paired-host",
      buildId: previous.buildId,
      bridgeVersion: 1
    )
    _ = try store.markSessionHealthy(sessionId: previousSession["sessionId"]!)
    store.closeSession(sessionId: previousSession["sessionId"]!)
    try stagePackage(store: store, host: "paired-host", fixture: current)
    let currentSession = try store.openSession(
      hostIdentity: "paired-host",
      buildId: current.buildId,
      bridgeVersion: 1
    )
    _ = try store.markSessionHealthy(sessionId: currentSession["sessionId"]!)
    store.closeSession(sessionId: currentSession["sessionId"]!)
    let currentDocument =
      root
      .appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
      .appendingPathComponent("generations")
      .appendingPathComponent(current.buildId)
      .appendingPathComponent("index.html")
    try Data("corrupt".utf8).write(to: currentDocument)

    let recovered = try store.openSession(
      hostIdentity: "paired-host",
      buildId: nil,
      bridgeVersion: 1
    )

    precondition(recovered["buildId"] == previous.buildId)
    precondition(!FileManager.default.fileExists(atPath: currentDocument.path))
  }

  private static func rejectsLowStorage(root: URL) throws {
    let store = MobileWebPackageStore(
      cacheRoot: root,
      availableStorageBytes: { _ in mobileWebMinimumFreeStorageBytes }
    )
    let fixture = try packageFixture()

    precondition(
      throwsCode("mobile_web_cache_storage_unavailable") {
        _ = try store.beginStage(
          hostIdentity: "paired-host",
          manifestJson: fixture.manifest,
          canonicalManifestJson: fixture.canonical
        )
      }
    )
    let staging =
      root
      .appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
      .appendingPathComponent("staging")
    let staged = try? FileManager.default.contentsOfDirectory(atPath: staging.path)
    precondition(staged?.isEmpty != false)
  }

  private static func evictsUnprotectedGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let active = try packageFixture(content: "<!doctype html><title>Active</title>")
    try stagePackage(store: store, host: "paired-host", fixture: active)
    let activeSession = try store.openSession(
      hostIdentity: "paired-host",
      buildId: active.buildId,
      bridgeVersion: 1
    )
    _ = try store.markSessionHealthy(sessionId: activeSession["sessionId"]!)
    let hostKey = sha256Hex(Data("paired-host".utf8))
    let staleRoot = try createSparseGeneration(
      root: root,
      hostKey: hostKey,
      buildId: String(repeating: "a", count: 64),
      byteLength: mobileWebPerHostCacheByteLimit
    )
    let fixture = try packageFixture(content: "<!doctype html><title>Next</title>")

    let stageId = try store.beginStage(
      hostIdentity: "paired-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )

    precondition(!FileManager.default.fileExists(atPath: staleRoot.path))
    let activeAsset = try store.readAsset(
      sessionId: activeSession["sessionId"]!,
      path: "index.html"
    )
    precondition(activeAsset.data == active.bytes)
    store.abortStage(stageId: stageId)
  }

  private static func evictsAnotherHostForGlobalQuota(root: URL) throws {
    let staleRoot = try createSparseGeneration(
      root: root,
      hostKey: sha256Hex(Data("other-host".utf8)),
      buildId: String(repeating: "b", count: 64),
      byteLength: mobileWebGlobalCacheByteLimit
    )
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try packageFixture()

    let stageId = try store.beginStage(
      hostIdentity: "paired-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )

    precondition(!FileManager.default.fileExists(atPath: staleRoot.path))
    store.abortStage(stageId: stageId)
  }

  private static func removesOnlySelectedHost(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let removed = try packageFixture(content: "<!doctype html><title>Removed</title>")
    let retained = try packageFixture(content: "<!doctype html><title>Retained</title>")
    try stagePackage(store: store, host: "removed-host", fixture: removed)
    try stagePackage(store: store, host: "retained-host", fixture: retained)
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
    let interruptedStage = try store.beginStage(
      hostIdentity: "removed-host",
      manifestJson: removed.manifest,
      canonicalManifestJson: removed.canonical
    )

    try store.removeHost(hostIdentity: "removed-host")

    let removedRoot = root.appendingPathComponent(sha256Hex(Data("removed-host".utf8)))
    precondition(!FileManager.default.fileExists(atPath: removedRoot.path))
    precondition(
      throwsCode("mobile_web_asset_unavailable") {
        _ = try store.readAsset(sessionId: removedSession["sessionId"]!, path: "index.html")
      }
    )
    precondition(
      throwsCode("mobile_web_stage_unknown") {
        try store.writeAssetChunk(
          stageId: interruptedStage,
          path: "index.html",
          offset: 0,
          dataBase64: "YQ==",
          chunkSha256: sha256Hex(Data("a".utf8))
        )
      }
    )
    let asset = try store.readAsset(
      sessionId: retainedSession["sessionId"]!,
      path: "index.html"
    )
    precondition(asset.data == retained.bytes)
  }

  private static func stagePackage(
    store: MobileWebPackageStore,
    host: String,
    fixture: PackageFixture
  ) throws {
    let stageId = try store.beginStage(
      hostIdentity: host,
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )
    try store.writeAssetChunk(
      stageId: stageId,
      path: "index.html",
      offset: 0,
      dataBase64: fixture.bytes.base64EncodedString(),
      chunkSha256: sha256Hex(fixture.bytes)
    )
    try store.finishAsset(stageId: stageId, path: "index.html")
    let committed = try store.commitStage(stageId: stageId)
    precondition(committed == fixture.buildId)
  }

  private static func createSparseGeneration(
    root: URL,
    hostKey: String,
    buildId: String,
    byteLength: Int64
  ) throws -> URL {
    let generation =
      root
      .appendingPathComponent(hostKey)
      .appendingPathComponent("generations")
      .appendingPathComponent(buildId)
    try FileManager.default.createDirectory(at: generation, withIntermediateDirectories: true)
    let file = generation.appendingPathComponent("stale.bin")
    FileManager.default.createFile(atPath: file.path, contents: nil)
    let handle = try FileHandle(forWritingTo: file)
    try handle.truncate(atOffset: UInt64(byteLength))
    try handle.close()
    return generation
  }

  private static func packageFixture(
    content: String = "<!doctype html><title>Orca</title>",
    mutate: (inout [String: Any]) -> Void = { _ in }
  ) throws -> PackageFixture {
    let bytes = Data(content.utf8)
    var canonical: [String: Any] = [
      "schemaVersion": 1,
      "bridge": ["minimum": 1, "testedThrough": 1],
      "entrypoint": "index.html",
      "totalBytes": bytes.count,
      "assets": [
        [
          "path": "index.html",
          "sha256": sha256Hex(bytes),
          "byteLength": bytes.count,
          "contentType": "text/html; charset=utf-8",
          "role": "document",
        ]
      ],
    ]
    mutate(&canonical)
    let canonicalData = try JSONSerialization.data(
      withJSONObject: canonical,
      options: [.sortedKeys]
    )
    let buildId = sha256Hex(canonicalData)
    var manifest = canonical
    manifest["buildId"] = buildId
    let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    return PackageFixture(
      bytes: bytes,
      canonical: String(decoding: canonicalData, as: UTF8.self),
      manifest: String(decoding: manifestData, as: UTF8.self),
      buildId: buildId
    )
  }

  private static func mutateAsset(
    _ manifest: inout [String: Any],
    mutate: (inout [String: Any]) -> Void
  ) {
    var assets = manifest["assets"] as! [[String: Any]]
    mutate(&assets[0])
    manifest["assets"] = assets
  }

  private static func throwsError(_ body: () throws -> Void) -> Bool {
    do {
      try body()
      return false
    } catch {
      return true
    }
  }

  private static func throwsCode(_ code: String, _ body: () throws -> Void) -> Bool {
    do {
      try body()
      return false
    } catch {
      return error.localizedDescription == code
    }
  }
}

private struct PackageFixture {
  let bytes: Data
  let canonical: String
  let manifest: String
  let buildId: String
}

private func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
