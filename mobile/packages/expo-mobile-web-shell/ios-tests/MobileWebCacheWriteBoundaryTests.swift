import CryptoKit
import Foundation

enum MobileWebCacheWriteBoundaryTests {
  static func run(root: URL) throws {
    try verifyStageWrite(root: root.appendingPathComponent("stage"))
    try verifyActivationWrite(root: root.appendingPathComponent("activation"))
  }

  private static func verifyStageWrite(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let outside = root.appendingPathComponent("outside")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data("keep".utf8).write(to: outside)
    let fixture = try packageFixture()
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    let stageId = try store.beginStage(
      hostIdentity: "paired-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )
    let stagingRoot =
      cacheRoot
      .appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
      .appendingPathComponent("staging")
    let stageRoot = try FileManager.default.contentsOfDirectory(
      at: stagingRoot,
      includingPropertiesForKeys: nil
    ).first!
    let asset = stageRoot.appendingPathComponent("index.html")
    try FileManager.default.removeItem(at: asset)
    try FileManager.default.createSymbolicLink(at: asset, withDestinationURL: outside)

    precondition(
      throwsCode("mobile_web_stage_write_failed") {
        try store.writeAssetChunk(
          stageId: stageId,
          path: "index.html",
          offset: 0,
          dataBase64: fixture.bytes.base64EncodedString(),
          chunkSha256: sha256Hex(fixture.bytes)
        )
      }
    )
    let outsideData = try Data(contentsOf: outside)
    precondition(outsideData == Data("keep".utf8))
    store.abortStage(stageId: stageId)
  }

  private static func verifyActivationWrite(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("outside")
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    let activation = externalRoot.appendingPathComponent("activation.json")
    try Data("keep".utf8).write(to: activation)
    let externalFile = root.appendingPathComponent("outside-activation-file")
    try Data("keep-file".utf8).write(to: externalFile)
    let fixture = try packageFixture()
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    try stagePackage(store: store, fixture: fixture)
    let session = try store.openSession(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    let hostRoot = cacheRoot.appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
    let activationLink = hostRoot.appendingPathComponent("activation.json")
    try FileManager.default.createSymbolicLink(
      at: activationLink,
      withDestinationURL: externalFile
    )

    let activated = try store.markSessionHealthy(sessionId: session["sessionId"]!)
    precondition(activated == fixture.buildId)
    let externalFileData = try Data(contentsOf: externalFile)
    precondition(externalFileData == Data("keep-file".utf8))

    try FileManager.default.removeItem(at: hostRoot)
    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)

    precondition(
      throwsCode("mobile_web_activation_write_failed") {
        _ = try store.markSessionHealthy(sessionId: session["sessionId"]!)
      }
    )
    let activationData = try Data(contentsOf: activation)
    precondition(activationData == Data("keep".utf8))
  }

  private static func stagePackage(
    store: MobileWebPackageStore,
    fixture: PackageFixture
  ) throws {
    let stageId = try store.beginStage(
      hostIdentity: "paired-host",
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

  private static func packageFixture() throws -> PackageFixture {
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
    return PackageFixture(
      bytes: bytes,
      canonical: canonical,
      manifest: String(decoding: manifestData, as: UTF8.self),
      buildId: buildId
    )
  }

  private static func throwsCode(_ code: String, _ body: () throws -> Void) -> Bool {
    do {
      try body()
      return false
    } catch {
      return error.localizedDescription == code
    }
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

private struct PackageFixture {
  let bytes: Data
  let canonical: String
  let manifest: String
  let buildId: String
}
