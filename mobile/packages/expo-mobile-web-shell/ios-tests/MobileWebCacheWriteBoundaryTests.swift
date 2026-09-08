import Foundation

enum MobileWebCacheWriteBoundaryTests {
  static func run(root: URL) throws {
    try verifyStagedAssetWrite(root: root.appendingPathComponent("asset"))
    try verifyManifestWrite(root: root.appendingPathComponent("manifest"))
  }

  /// An asset slot replaced by a symlink must be overwritten in place, never followed.
  private static func verifyStagedAssetWrite(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let outside = root.appendingPathComponent("outside")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data("keep".utf8).write(to: outside)
    let fixture = try mobileWebStoreFixture()
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    try mobileWebStoreStageAsset(store: store, host: "paired-host", fixture: fixture)
    let asset = mobileWebStoreStagingRoot(
      cacheRoot: cacheRoot,
      host: "paired-host",
      buildId: fixture.buildId
    ).appendingPathComponent("index.html")
    try FileManager.default.removeItem(at: asset)
    try FileManager.default.createSymbolicLink(at: asset, withDestinationURL: outside)

    try mobileWebStoreStageAsset(store: store, host: "paired-host", fixture: fixture)

    let preserved = try Data(contentsOf: outside)
    precondition(preserved == Data("keep".utf8))
    precondition(!mobileWebStoreIsSymbolicLink(asset))
    let committed = try store.commitGeneration(
      hostIdentity: "paired-host",
      buildId: fixture.buildId,
      manifestJson: fixture.manifestJson
    )
    precondition(committed == fixture.buildId)
  }

  /// A symlinked manifest slot must not let the commit write through the cache boundary.
  private static func verifyManifestWrite(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let outside = root.appendingPathComponent("outside-manifest")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data("keep".utf8).write(to: outside)
    let fixture = try mobileWebStoreFixture()
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    try mobileWebStoreStageAsset(store: store, host: "paired-host", fixture: fixture)
    let stageRoot = mobileWebStoreStagingRoot(
      cacheRoot: cacheRoot,
      host: "paired-host",
      buildId: fixture.buildId
    )
    try FileManager.default.createSymbolicLink(
      at: stageRoot.appendingPathComponent("manifest.json"),
      withDestinationURL: outside
    )

    // A staged tree carrying an extra entry is refused before anything is written.
    precondition(
      mobileWebStoreThrowsCode("mobile_web_staged_generation_incomplete") {
        _ = try store.commitGeneration(
          hostIdentity: "paired-host",
          buildId: fixture.buildId,
          manifestJson: fixture.manifestJson
        )
      }
    )
    let preserved = try Data(contentsOf: outside)
    precondition(preserved == Data("keep".utf8))
  }
}
