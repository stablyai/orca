import Foundation

/// Every operation resolves the host root before it writes, so a symlinked host directory can never
/// reach outside the cache.
enum MobileWebHostRootBoundaryTests {
  private static let hostIdentity = "paired-host"

  static func run(root: URL) throws {
    let fixture = try mobileWebStoreFixture()
    try verifyCleanupAndStaging(root: root.appendingPathComponent("cleanup"), fixture: fixture)
    try verifyCommit(root: root.appendingPathComponent("commit"), fixture: fixture)
    try verifySessionAndRemoval(root: root.appendingPathComponent("session"), fixture: fixture)
  }

  private static func verifyCleanupAndStaging(
    root: URL,
    fixture: MobileWebStoreFixture
  ) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("external")
    let hostRoot = mobileWebStoreHostRoot(cacheRoot: cacheRoot, host: hostIdentity)
    try FileManager.default.createDirectory(
      at: externalRoot.appendingPathComponent("tmp/orphan"),
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: externalRoot.appendingPathComponent("generations/\(fixture.buildId)"),
      withIntermediateDirectories: true
    )
    try Data("keep-stage".utf8).write(to: externalRoot.appendingPathComponent("tmp/orphan/asset"))
    try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)

    let before = try mobileWebStoreTreeSnapshot(externalRoot)
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)

    let afterCleanup = try mobileWebStoreTreeSnapshot(externalRoot)
    precondition(afterCleanup == before)
    precondition(!mobileWebStoreIsSymbolicLink(hostRoot))

    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)
    precondition(
      mobileWebStoreThrowsCode("mobile_web_staged_write_failed") {
        try mobileWebStoreStageAsset(store: store, host: hostIdentity, fixture: fixture)
      }
    )
    let afterStaging = try mobileWebStoreTreeSnapshot(externalRoot)
    precondition(afterStaging == before)
  }

  private static func verifyCommit(root: URL, fixture: MobileWebStoreFixture) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("external")
    let hostRoot = mobileWebStoreHostRoot(cacheRoot: cacheRoot, host: hostIdentity)
    try FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true)
    try Data("keep".utf8).write(to: externalRoot.appendingPathComponent("sentinel"))
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    try mobileWebStoreStageAsset(store: store, host: hostIdentity, fixture: fixture)
    try FileManager.default.removeItem(at: hostRoot)
    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)
    let before = try mobileWebStoreTreeSnapshot(externalRoot)

    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_commit_failed") {
        _ = try store.commitGeneration(
          hostIdentity: hostIdentity,
          buildId: fixture.buildId,
          manifestJson: fixture.manifestJson
        )
      }
    )
    let afterCommit = try mobileWebStoreTreeSnapshot(externalRoot)
    precondition(afterCommit == before)
  }

  private static func verifySessionAndRemoval(root: URL, fixture: MobileWebStoreFixture) throws {
    let cacheRoot = root.appendingPathComponent("cache")
    let externalRoot = root.appendingPathComponent("external")
    let hostRoot = mobileWebStoreHostRoot(cacheRoot: cacheRoot, host: hostIdentity)
    let store = MobileWebPackageStore(cacheRoot: cacheRoot)
    try mobileWebStoreCommit(store: store, host: hostIdentity, fixture: fixture)
    let session = try store.openSession(
      hostIdentity: hostIdentity,
      buildId: fixture.buildId,
      bridgeVersion: 1
    )
    try FileManager.default.copyItem(at: hostRoot, to: externalRoot)
    try FileManager.default.removeItem(at: hostRoot)
    try FileManager.default.createSymbolicLink(at: hostRoot, withDestinationURL: externalRoot)
    let before = try mobileWebStoreTreeSnapshot(externalRoot)

    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(
          hostIdentity: hostIdentity,
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
      }
    )
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.openSession(hostIdentity: hostIdentity, buildId: nil, bridgeVersion: 1)
      }
    )
    precondition(
      mobileWebStoreThrowsCode("mobile_web_generation_invalid") {
        _ = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
      }
    )
    let afterSessions = try mobileWebStoreTreeSnapshot(externalRoot)
    precondition(afterSessions == before)

    try store.removeHost(hostIdentity: hostIdentity)
    precondition(!mobileWebStoreIsSymbolicLink(hostRoot))
    let afterRemoval = try mobileWebStoreTreeSnapshot(externalRoot)
    precondition(afterRemoval == before)
  }
}
