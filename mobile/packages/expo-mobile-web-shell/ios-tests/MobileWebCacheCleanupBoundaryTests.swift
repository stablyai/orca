import CryptoKit
import Foundation

enum MobileWebCacheCleanupBoundaryTests {
  static func run(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("external")
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    let sentinel = externalRoot.appendingPathComponent("sentinel")
    try Data("keep".utf8).write(to: sentinel)

    let hostRoot =
      cacheRoot
      .appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
    let stagingRoot = hostRoot.appendingPathComponent("staging")
    try FileManager.default.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
    let orphanLink = stagingRoot.appendingPathComponent("orphan")
    try FileManager.default.createSymbolicLink(
      at: orphanLink,
      withDestinationURL: externalRoot
    )

    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    precondition(FileManager.default.fileExists(atPath: sentinel.path))
    precondition(!FileManager.default.fileExists(atPath: orphanLink.path))

    let hostLink = hostRoot.appendingPathComponent("linked-external")
    try FileManager.default.createSymbolicLink(
      at: hostLink,
      withDestinationURL: externalRoot
    )
    try store.removeHost(hostIdentity: "paired-host")
    precondition(FileManager.default.fileExists(atPath: sentinel.path))
    precondition(!FileManager.default.fileExists(atPath: hostRoot.path))

    try verifyNestedCleanup(root: root)
    try verifyLiveStageReplacement(root: root)
    try verifyDanglingHostRemoval(root: root)
  }

  private static func verifyNestedCleanup(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache-nested")
    let externalRoot = root.appendingPathComponent("external-nested")
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    let sentinel = externalRoot.appendingPathComponent("sentinel")
    try Data("keep".utf8).write(to: sentinel)
    let orphanRoot =
      cacheRoot
      .appendingPathComponent(sha256Hex(Data("nested-host".utf8)))
      .appendingPathComponent("staging/orphan")
    try FileManager.default.createDirectory(at: orphanRoot, withIntermediateDirectories: true)
    try Data("remove".utf8).write(to: orphanRoot.appendingPathComponent("local"))
    try FileManager.default.createSymbolicLink(
      at: orphanRoot.appendingPathComponent("external"),
      withDestinationURL: externalRoot
    )

    _ = MobileWebPackageStore(cacheRoot: cacheRoot)

    precondition(FileManager.default.fileExists(atPath: sentinel.path))
    precondition(!FileManager.default.fileExists(atPath: orphanRoot.path))
  }

  private static func verifyLiveStageReplacement(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache-live")
    let externalRoot = root.appendingPathComponent("external-live")
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    let sentinel = externalRoot.appendingPathComponent("sentinel")
    try Data("keep".utf8).write(to: sentinel)
    let fixture = try packageFixture()
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    let firstStage = try store.beginStage(
      hostIdentity: "live-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )
    let stagingRoot =
      cacheRoot
      .appendingPathComponent(sha256Hex(Data("live-host".utf8)))
      .appendingPathComponent("staging")
    let stageRoot = try FileManager.default.contentsOfDirectory(
      at: stagingRoot,
      includingPropertiesForKeys: nil
    ).first!
    try FileManager.default.removeItem(at: stageRoot)
    try FileManager.default.createSymbolicLink(at: stageRoot, withDestinationURL: externalRoot)

    let secondStage = try store.beginStage(
      hostIdentity: "live-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )

    precondition(FileManager.default.fileExists(atPath: sentinel.path))
    precondition(
      (try? FileManager.default.destinationOfSymbolicLink(atPath: stageRoot.path)) == nil
    )
    store.abortStage(stageId: firstStage)
    store.abortStage(stageId: secondStage)
  }

  private static func verifyDanglingHostRemoval(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache-dangling")
    try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    let hostRoot =
      cacheRoot
      .appendingPathComponent(sha256Hex(Data("dangling-host".utf8)))
    try FileManager.default.createSymbolicLink(
      at: hostRoot,
      withDestinationURL: root.appendingPathComponent("missing-target")
    )
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)

    try store.removeHost(hostIdentity: "dangling-host")

    precondition(
      (try? FileManager.default.destinationOfSymbolicLink(atPath: hostRoot.path)) == nil
    )
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func packageFixture() throws -> (manifest: String, canonical: String) {
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
    var manifestObject = canonicalObject
    manifestObject["buildId"] = sha256Hex(canonicalData)
    let manifestData = try JSONSerialization.data(
      withJSONObject: manifestObject,
      options: [.sortedKeys]
    )
    return (String(decoding: manifestData, as: UTF8.self), canonical)
  }
}
