import Foundation

enum MobileWebPackageStoreGeneratedMutationTests {
  static func run(root: URL) throws {
    try rejectGeneratedManifestMutations(root: root.appendingPathComponent("manifests"))
    try rejectGeneratedAssetMutations(root: root.appendingPathComponent("assets"))
    rejectGeneratedTokenMutations()
  }

  private static func rejectGeneratedManifestMutations(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    let source = Array(fixture.manifestJson.utf8)

    for iteration in 0..<256 {
      var bytes = source
      bytes[generatedMutationIndex(iteration, upperBound: bytes.count)] = 0
      precondition(
        mobileWebStoreThrowsCode("mobile_web_manifest_invalid") {
          _ = try store.commitGeneration(
            hostIdentity: "generated-host",
            buildId: fixture.buildId,
            manifestJson: String(decoding: bytes, as: UTF8.self)
          )
        }
      )
    }
  }

  private static func rejectGeneratedAssetMutations(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture()
    let encoded = fixture.bytes.base64EncodedString()

    for iteration in 0..<256 {
      var characters = Array(encoded)
      characters[generatedMutationIndex(iteration, upperBound: characters.count)] = "!"
      precondition(
        mobileWebStoreThrowsCode("mobile_web_staged_asset_invalid") {
          try store.writeStagedAsset(
            hostIdentity: "generated-host",
            buildId: fixture.buildId,
            path: "index.html",
            dataBase64: String(characters)
          )
        }
      )
    }
    // Bytes that decode but do not match the manifest hash are caught at commit, not at write.
    try store.writeStagedAsset(
      hostIdentity: "generated-host",
      buildId: fixture.buildId,
      path: "index.html",
      dataBase64: Data("mismatched payload".utf8).base64EncodedString()
    )
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.commitGeneration(
          hostIdentity: "generated-host",
          buildId: fixture.buildId,
          manifestJson: fixture.manifestJson
        )
      }
    )
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

private func generatedMutationIndex(_ seed: Int, upperBound: Int) -> Int {
  Int((UInt64(seed) &* 1_103_515_245 &+ 12_345) % UInt64(upperBound))
}
