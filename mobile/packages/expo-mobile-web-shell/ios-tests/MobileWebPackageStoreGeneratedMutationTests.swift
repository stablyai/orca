import CryptoKit
import Foundation

enum MobileWebPackageStoreGeneratedMutationTests {
  static func run(root: URL) throws {
    try rejectGeneratedManifestMutations(root: root.appendingPathComponent("manifests"))
    try rejectGeneratedChunkMutations(root: root.appendingPathComponent("chunks"))
    rejectGeneratedTokenMutations()
  }

  private static func rejectGeneratedManifestMutations(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try generatedMutationFixture()
    let source = Array(fixture.manifest.utf8)

    for iteration in 0..<256 {
      var bytes = source
      bytes[generatedMutationIndex(iteration, upperBound: bytes.count)] = 0
      let manifest = String(decoding: bytes, as: UTF8.self)
      precondition(
        generatedMutationThrows("mobile_web_stage_manifest_invalid") {
          _ = try store.beginStage(
            hostIdentity: "generated-host",
            manifestJson: manifest,
            canonicalManifestJson: fixture.canonical
          )
        }
      )
    }
  }

  private static func rejectGeneratedChunkMutations(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try generatedMutationFixture()
    let stageId = try store.beginStage(
      hostIdentity: "generated-host",
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )
    let encoded = fixture.bytes.base64EncodedString()

    for iteration in 0..<256 {
      var characters = Array(encoded)
      characters[generatedMutationIndex(iteration, upperBound: characters.count)] = "!"
      precondition(
        generatedMutationThrows("mobile_web_stage_chunk_invalid") {
          try store.writeAssetChunk(
            stageId: stageId,
            path: "index.html",
            offset: 0,
            dataBase64: String(characters),
            chunkSha256: generatedMutationSha256(fixture.bytes)
          )
        }
      )
    }
    for offset in 1...128 {
      precondition(
        generatedMutationThrows("mobile_web_stage_offset_invalid") {
          try store.writeAssetChunk(
            stageId: stageId,
            path: "index.html",
            offset: offset,
            dataBase64: encoded,
            chunkSha256: generatedMutationSha256(fixture.bytes)
          )
        }
      )
    }
    store.abortStage(stageId: stageId)
  }

  private static func rejectGeneratedTokenMutations() {
    let path = "assets/\(String(repeating: "a", count: 64)).js"
    let forbidden = ["\\", "?", "#", "%", "\n", "\0", "é"]
    for iteration in 0..<256 {
      var characters = Array(path)
      characters.insert(
        Character(forbidden[iteration % forbidden.count]),
        at: generatedMutationIndex(iteration, upperBound: characters.count + 1)
      )
      precondition(!isSafeMobileWebAssetPath(String(characters)))
    }

    let hash = String(repeating: "a", count: 64)
    for iteration in 0..<256 {
      var characters = Array(hash)
      characters[generatedMutationIndex(iteration, upperBound: characters.count)] =
        iteration.isMultiple(of: 2) ? "A" : "!"
      precondition(!isMobileWebSha256(String(characters)))
    }
  }
}

private struct GeneratedMutationFixture {
  let bytes: Data
  let canonical: String
  let manifest: String
}

private func generatedMutationFixture() throws -> GeneratedMutationFixture {
  let bytes = Data("<!doctype html><title>Generated mutation</title>".utf8)
  let canonicalObject: [String: Any] = [
    "schemaVersion": 1,
    "bridge": ["minimum": 1, "testedThrough": 1],
    "entrypoint": "index.html",
    "totalBytes": bytes.count,
    "assets": [
      [
        "path": "index.html",
        "sha256": generatedMutationSha256(bytes),
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
  var manifestObject = canonicalObject
  manifestObject["buildId"] = generatedMutationSha256(canonicalData)
  let manifestData = try JSONSerialization.data(
    withJSONObject: manifestObject,
    options: [.sortedKeys]
  )
  return GeneratedMutationFixture(
    bytes: bytes,
    canonical: String(decoding: canonicalData, as: UTF8.self),
    manifest: String(decoding: manifestData, as: UTF8.self)
  )
}

private func generatedMutationIndex(_ seed: Int, upperBound: Int) -> Int {
  Int((UInt64(seed) &* 1_103_515_245 &+ 12_345) % UInt64(upperBound))
}

private func generatedMutationSha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func generatedMutationThrows(_ code: String, _ body: () throws -> Void) -> Bool {
  do {
    try body()
    return false
  } catch {
    return error.localizedDescription == code
  }
}
