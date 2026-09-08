import Foundation

enum MobileWebCacheCleanupBoundaryTests {
  static func run(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("external")
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    let sentinel = externalRoot.appendingPathComponent("sentinel")
    try Data("keep".utf8).write(to: sentinel)

    let hostRoot = mobileWebStoreHostRoot(cacheRoot: cacheRoot, host: "paired-host")
    let stagingRoot = hostRoot.appendingPathComponent("tmp")
    try FileManager.default.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
    let orphanLink = stagingRoot.appendingPathComponent("orphan")
    try FileManager.default.createSymbolicLink(at: orphanLink, withDestinationURL: externalRoot)

    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    precondition(FileManager.default.fileExists(atPath: sentinel.path))
    precondition(!FileManager.default.fileExists(atPath: stagingRoot.path))

    let hostLink = hostRoot.appendingPathComponent("linked-external")
    try FileManager.default.createSymbolicLink(at: hostLink, withDestinationURL: externalRoot)
    try store.removeHost(hostIdentity: "paired-host")
    precondition(FileManager.default.fileExists(atPath: sentinel.path))
    precondition(!FileManager.default.fileExists(atPath: hostRoot.path))

    try verifyNestedCleanup(root: root)
    try verifyLinkedStageReplacement(root: root)
    try verifyDanglingHostRemoval(root: root)
  }

  private static func verifyNestedCleanup(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache-nested")
    let externalRoot = root.appendingPathComponent("external-nested")
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    let sentinel = externalRoot.appendingPathComponent("sentinel")
    try Data("keep".utf8).write(to: sentinel)
    let orphanRoot = mobileWebStoreHostRoot(cacheRoot: cacheRoot, host: "nested-host")
      .appendingPathComponent("tmp/orphan")
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

  /// A staged tree replaced by a symlink must be written through, not followed outside the cache.
  private static func verifyLinkedStageReplacement(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache-live")
    let externalRoot = root.appendingPathComponent("external-live")
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    let sentinel = externalRoot.appendingPathComponent("sentinel")
    try Data("keep".utf8).write(to: sentinel)
    let before = try mobileWebStoreTreeSnapshot(externalRoot)
    let fixture = try mobileWebStoreFixture()
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    try mobileWebStoreStageAsset(store: store, host: "live-host", fixture: fixture)
    let stageRoot = mobileWebStoreStagingRoot(
      cacheRoot: cacheRoot,
      host: "live-host",
      buildId: fixture.buildId
    )
    try FileManager.default.removeItem(at: stageRoot)
    try FileManager.default.createSymbolicLink(at: stageRoot, withDestinationURL: externalRoot)

    precondition(
      mobileWebStoreThrowsCode("mobile_web_staged_write_failed") {
        try mobileWebStoreStageAsset(store: store, host: "live-host", fixture: fixture)
      }
    )

    precondition(FileManager.default.fileExists(atPath: sentinel.path))
    let after = try mobileWebStoreTreeSnapshot(externalRoot)
    precondition(after == before)
  }

  private static func verifyDanglingHostRemoval(root: URL) throws {
    let cacheRoot = root.appendingPathComponent("cache-dangling")
    try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    let hostRoot = mobileWebStoreHostRoot(cacheRoot: cacheRoot, host: "dangling-host")
    try FileManager.default.createSymbolicLink(
      at: hostRoot,
      withDestinationURL: root.appendingPathComponent("missing-target")
    )
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)

    try store.removeHost(hostIdentity: "dangling-host")

    precondition(!mobileWebStoreIsSymbolicLink(hostRoot))
  }
}
