import CryptoKit
import Foundation

/// The manifest bytes are the canonical document whose sha256 is the build id, so tests that mutate
/// the manifest must re-derive the id the same way the desktop does.
struct MobileWebStoreFixture: Sendable {
  let bytes: Data
  let manifestJson: String
  let buildId: String
}

func mobileWebStoreFixture(
  content: String = "<!doctype html><title>Orca</title>",
  mutate: (inout [String: Any]) -> Void = { _ in }
) throws -> MobileWebStoreFixture {
  let bytes = Data(content.utf8)
  var manifest: [String: Any] = [
    "schemaVersion": 1,
    "bridge": ["minimum": 1, "testedThrough": 1],
    "entrypoint": "index.html",
    "totalBytes": bytes.count,
    "assets": [
      [
        "path": "index.html",
        "sha256": mobileWebStoreSha256Hex(bytes),
        "byteLength": bytes.count,
        "contentType": "text/html; charset=utf-8",
        "role": "document",
      ]
    ],
  ]
  mutate(&manifest)
  let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
  return MobileWebStoreFixture(
    bytes: bytes,
    manifestJson: String(decoding: manifestData, as: UTF8.self),
    buildId: mobileWebStoreSha256Hex(manifestData)
  )
}

func mobileWebStoreFixtureRebuilt(
  from fixture: MobileWebStoreFixture,
  manifestJson: String
) -> MobileWebStoreFixture {
  MobileWebStoreFixture(
    bytes: fixture.bytes,
    manifestJson: manifestJson,
    buildId: mobileWebStoreSha256Hex(Data(manifestJson.utf8))
  )
}

func mobileWebStoreMutateAsset(
  _ manifest: inout [String: Any],
  mutate: (inout [String: Any]) -> Void
) {
  var assets = manifest["assets"] as! [[String: Any]]
  mutate(&assets[0])
  manifest["assets"] = assets
}

func mobileWebStoreStageAsset(
  store: MobileWebPackageStore,
  host: String,
  fixture: MobileWebStoreFixture
) throws {
  try store.writeStagedAsset(
    hostIdentity: host,
    buildId: fixture.buildId,
    path: "index.html",
    dataBase64: fixture.bytes.base64EncodedString()
  )
}

func mobileWebStoreCommit(
  store: MobileWebPackageStore,
  host: String,
  fixture: MobileWebStoreFixture
) throws {
  try mobileWebStoreStageAsset(store: store, host: host, fixture: fixture)
  let committed = try store.commitGeneration(
    hostIdentity: host,
    buildId: fixture.buildId,
    manifestJson: fixture.manifestJson
  )
  precondition(committed == fixture.buildId)
}

func mobileWebStoreHostRoot(cacheRoot: URL, host: String) -> URL {
  cacheRoot.appendingPathComponent(mobileWebStoreSha256Hex(Data(host.utf8)), isDirectory: true)
}

func mobileWebStoreGenerationRoot(cacheRoot: URL, host: String, buildId: String) -> URL {
  mobileWebStoreHostRoot(cacheRoot: cacheRoot, host: host)
    .appendingPathComponent("generations", isDirectory: true)
    .appendingPathComponent(buildId, isDirectory: true)
}

func mobileWebStoreStagingRoot(cacheRoot: URL, host: String, buildId: String) -> URL {
  mobileWebStoreHostRoot(cacheRoot: cacheRoot, host: host)
    .appendingPathComponent("tmp", isDirectory: true)
    .appendingPathComponent(buildId, isDirectory: true)
}

func mobileWebStoreSha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func mobileWebStoreThrows(_ body: () throws -> Void) -> Bool {
  do {
    try body()
    return false
  } catch {
    return true
  }
}

func mobileWebStoreThrowsCode(_ code: String, _ body: () throws -> Void) -> Bool {
  do {
    try body()
    return false
  } catch {
    return error.localizedDescription == code
  }
}

func mobileWebStoreTreeSnapshot(_ root: URL) throws -> [String: String] {
  guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
  else { return [:] }
  // The enumerator reports resolved paths, so a temporary directory behind /var strips wrongly
  // unless both spellings of the root are tried.
  let prefixes = [root.standardizedFileURL.path, root.resolvingSymlinksInPath().path]
    .map { $0.hasSuffix("/") ? $0 : $0 + "/" }
  var snapshot = [String: String]()
  for case let child as URL in enumerator {
    let full = child.standardizedFileURL.path
    let relative =
      prefixes.compactMap { full.hasPrefix($0) ? String(full.dropFirst($0.count)) : nil }.first
      ?? full
    let values = try child.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true else {
      snapshot[relative] = "directory"
      continue
    }
    let size = values.fileSize ?? 0
    let digest = size <= 1024 * 1024 ? mobileWebStoreSha256Hex(try Data(contentsOf: child)) : "large"
    snapshot[relative] = "\(size):\(digest)"
  }
  return snapshot
}

func mobileWebStoreIsSymbolicLink(_ url: URL) -> Bool {
  (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil
}
