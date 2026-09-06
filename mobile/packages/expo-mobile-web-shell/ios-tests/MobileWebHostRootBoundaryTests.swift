import CryptoKit
import Foundation

enum MobileWebHostRootBoundaryTests {
  static func run(root: URL) throws {
    let fixture = try packageFixture()
    try verifyCleanupAndStaging(root: root.appendingPathComponent("cleanup"), fixture: fixture)
    try verifyCommit(root: root.appendingPathComponent("commit"), fixture: fixture)
    try verifySessionAndRemoval(root: root.appendingPathComponent("session"), fixture: fixture)
  }

  private static func verifyCleanupAndStaging(
    root: URL,
    fixture: HostRootPackageFixture
  ) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("external")
    let hostRoot = cacheRoot.appendingPathComponent(hostKey)
    let externalGeneration =
      externalRoot
      .appendingPathComponent("generations")
      .appendingPathComponent(fixture.buildId)
    try FileManager.default.createDirectory(
      at: externalRoot.appendingPathComponent("staging/orphan"),
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: externalGeneration,
      withIntermediateDirectories: true
    )
    try Data("keep-stage".utf8).write(
      to: externalRoot.appendingPathComponent("staging/orphan/asset")
    )
    try Data("keep-temp".utf8).write(
      to: externalRoot.appendingPathComponent("activation-orphan.tmp")
    )
    let sparse = externalGeneration.appendingPathComponent("payload")
    FileManager.default.createFile(atPath: sparse.path, contents: nil)
    let sparseHandle = try FileHandle(forWritingTo: sparse)
    try sparseHandle.truncate(atOffset: 140 * 1024 * 1024)
    try sparseHandle.close()
    try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)

    let before = try treeSnapshot(externalRoot)
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)

    let afterCleanup = try treeSnapshot(externalRoot)
    precondition(afterCleanup == before)
    precondition(!isSymbolicLink(hostRoot))

    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)
    let stageId = try store.beginStage(
      hostIdentity: hostIdentity,
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )

    let afterStaging = try treeSnapshot(externalRoot)
    precondition(afterStaging == before)
    precondition(!isSymbolicLink(hostRoot))
    store.abortStage(stageId: stageId)
  }

  private static func verifyCommit(
    root: URL,
    fixture: HostRootPackageFixture
  ) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("external")
    let hostRoot = cacheRoot.appendingPathComponent(hostKey)
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    try Data("keep".utf8).write(to: externalRoot.appendingPathComponent("sentinel"))
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    let stageId = try finishedStage(store: store, fixture: fixture)
    try FileManager.default.removeItem(at: hostRoot)
    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)
    let before = try treeSnapshot(externalRoot)

    precondition(
      throwsCode("mobile_web_generation_commit_failed") {
        _ = try store.commitStage(stageId: stageId)
      }
    )
    let afterCommit = try treeSnapshot(externalRoot)
    precondition(afterCommit == before)
    store.abortStage(stageId: stageId)
  }

  private static func verifySessionAndRemoval(
    root: URL,
    fixture: HostRootPackageFixture
  ) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("external")
    let hostRoot = cacheRoot.appendingPathComponent(hostKey)
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    let stageId = try finishedStage(store: store, fixture: fixture)
    _ = try store.commitStage(stageId: stageId)
    let session = try store.openSession(
      hostIdentity: hostIdentity,
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    _ = try store.markSessionHealthy(sessionId: session["sessionId"]!)
    try FileManager.default.copyItem(at: hostRoot, to: externalRoot)
    try FileManager.default.removeItem(at: hostRoot)
    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)
    let generationRoot =
      externalRoot
      .appendingPathComponent("generations")
      .appendingPathComponent(fixture.buildId)
    let oldDate = Date(timeIntervalSince1970: 1_000)
    try FileManager.default.setAttributes(
      [.modificationDate: oldDate],
      ofItemAtPath: generationRoot.path
    )
    let before = try treeSnapshot(externalRoot)

    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: hostIdentity,
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
    precondition(
      throwsCode("mobile_web_activation_invalid") {
        _ = try store.openSession(hostIdentity: hostIdentity, buildId: nil, bridgeVersion: 1)
      }
    )
    precondition(
      throwsCode("mobile_web_activation_write_failed") {
        _ = try store.markSessionHealthy(sessionId: session["sessionId"]!)
      }
    )
    precondition(
      throwsCode("mobile_web_activation_invalid") {
        _ = try store.recoverSession(sessionId: session["sessionId"]!)
      }
    )
    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
      }
    )
    let afterSessions = try treeSnapshot(externalRoot)
    precondition(afterSessions == before)
    let values = try generationRoot.resourceValues(forKeys: [.contentModificationDateKey])
    precondition(values.contentModificationDate == oldDate)

    try store.removeHost(hostIdentity: hostIdentity)
    precondition(!isSymbolicLink(hostRoot))
    let afterRemoval = try treeSnapshot(externalRoot)
    precondition(afterRemoval == before)
  }

  private static func finishedStage(
    store: MobileWebPackageStore,
    fixture: HostRootPackageFixture
  ) throws -> String {
    let stageId = try store.beginStage(
      hostIdentity: hostIdentity,
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
    return stageId
  }

  private static func treeSnapshot(_ root: URL) throws -> [String: String] {
    guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
    else { return [:] }
    var snapshot = [String: String]()
    for case let child as URL in enumerator {
      let relative = String(child.path.dropFirst(root.path.count + 1))
      let values = try child.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
      guard values.isRegularFile == true else {
        snapshot[relative] = "directory"
        continue
      }
      let size = values.fileSize ?? 0
      let digest = size <= 1024 * 1024 ? sha256Hex(try Data(contentsOf: child)) : "large"
      snapshot[relative] = "\(size):\(digest)"
    }
    return snapshot
  }

  private static func isSymbolicLink(_ url: URL) -> Bool {
    (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil
  }

  private static func throwsCode(_ code: String, _ body: () throws -> Void) -> Bool {
    do {
      try body()
      return false
    } catch {
      return error.localizedDescription == code
    }
  }

  private static func packageFixture() throws -> HostRootPackageFixture {
    let bytes = Data("<!doctype html><title>Orca</title>".utf8)
    let canonicalObject: [String: Any] = [
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
    let canonicalData = try JSONSerialization.data(
      withJSONObject: canonicalObject,
      options: [.sortedKeys]
    )
    let canonical = String(decoding: canonicalData, as: UTF8.self)
    let buildId = sha256Hex(canonicalData)
    var manifestObject = canonicalObject
    manifestObject["buildId"] = buildId
    let manifestData = try JSONSerialization.data(
      withJSONObject: manifestObject,
      options: [.sortedKeys]
    )
    return HostRootPackageFixture(
      bytes: bytes,
      canonical: canonical,
      manifest: String(decoding: manifestData, as: UTF8.self),
      buildId: buildId
    )
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static let hostIdentity = "paired-host"
  private static let hostKey = sha256Hex(Data(hostIdentity.utf8))
}

private struct HostRootPackageFixture {
  let bytes: Data
  let canonical: String
  let manifest: String
  let buildId: String
}
