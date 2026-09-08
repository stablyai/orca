import Foundation

enum MobileWebPackageStoreConcurrencyTests {
  static func run(root: URL) throws {
    try exerciseIndependentHosts(root: root.appendingPathComponent("hosts"))
    try exerciseDuplicateGeneration(root: root.appendingPathComponent("duplicate"))
    try exerciseCompetingGenerations(root: root.appendingPathComponent("generations"))
    try exerciseCommitAndAbort(root: root.appendingPathComponent("commit-abort"))
  }

  private static func exerciseIndependentHosts(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let failures = ConcurrentFailureCollector()

    DispatchQueue.concurrentPerform(iterations: 24) { iteration in
      do {
        let index = iteration % 4
        let host = "concurrent-host-\(index)"
        let fixture = try mobileWebStoreFixture(content: "<title>\(index)</title>")
        try mobileWebStoreCommit(store: store, host: host, fixture: fixture)
        let session = try store.openSession(
          hostIdentity: host,
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
        let asset = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
        precondition(asset.data == fixture.bytes)
        store.closeSession(sessionId: session["sessionId"]!)
      } catch {
        failures.append(error)
      }
    }

    precondition(failures.isEmpty)
    let hostRoots = try FileManager.default.contentsOfDirectory(atPath: root.path)
    precondition(hostRoots.count == 4)
  }

  private static func exerciseDuplicateGeneration(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixture = try mobileWebStoreFixture(content: "<title>same generation</title>")
    let failures = ConcurrentFailureCollector()

    DispatchQueue.concurrentPerform(iterations: 24) { _ in
      do {
        try mobileWebStoreCommit(store: store, host: "same-host", fixture: fixture)
      } catch {
        failures.append(error)
      }
    }

    precondition(failures.isEmpty)
    DispatchQueue.concurrentPerform(iterations: 24) { _ in
      do {
        let session = try store.openSession(
          hostIdentity: "same-host",
          buildId: fixture.buildId,
          bridgeVersion: 1
        )
        let asset = try store.readAsset(sessionId: session["sessionId"]!, path: "index.html")
        precondition(asset.data == fixture.bytes)
        store.closeSession(sessionId: session["sessionId"]!)
      } catch {
        failures.append(error)
      }
    }
    precondition(failures.isEmpty)
    let active = try store.openSession(hostIdentity: "same-host", buildId: nil, bridgeVersion: 1)
    let activeAsset = try store.readAsset(sessionId: active["sessionId"]!, path: "index.html")
    precondition(activeAsset.data == fixture.bytes)
    let staging = mobileWebStoreHostRoot(cacheRoot: root, host: "same-host")
      .appendingPathComponent("tmp")
    let staged = try? FileManager.default.contentsOfDirectory(atPath: staging.path)
    precondition(staged?.isEmpty != false)
  }

  /// Competing commits for one host converge on exactly one generation, whichever wins the lock.
  private static func exerciseCompetingGenerations(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixtures = try (0..<16).map {
      try mobileWebStoreFixture(content: "<title>generation-\($0)</title>")
    }
    let failures = ConcurrentFailureCollector()

    DispatchQueue.concurrentPerform(iterations: fixtures.count) { index in
      do {
        try mobileWebStoreCommit(store: store, host: "generation-host", fixture: fixtures[index])
      } catch {
        failures.append(error)
      }
    }
    precondition(failures.isEmpty)

    let generations = mobileWebStoreHostRoot(cacheRoot: root, host: "generation-host")
      .appendingPathComponent("generations")
    let retained = try FileManager.default.contentsOfDirectory(atPath: generations.path)
    precondition(retained.count == 1)
    let active = try store.openSession(
      hostIdentity: "generation-host",
      buildId: nil,
      bridgeVersion: 1
    )
    precondition(active["buildId"] == retained[0])
    let activeFixture = fixtures.first { $0.buildId == retained[0] }!
    let activeAsset = try store.readAsset(sessionId: active["sessionId"]!, path: "index.html")
    precondition(activeAsset.data == activeFixture.bytes)
    store.closeSession(sessionId: active["sessionId"]!)
  }

  private static func exerciseCommitAndAbort(root: URL) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let fixtures = try (0..<16).map {
      try mobileWebStoreFixture(content: "<title>stage-\($0)</title>")
    }
    for fixture in fixtures {
      try mobileWebStoreStageAsset(store: store, host: "stage-host", fixture: fixture)
    }
    let failures = ConcurrentFailureCollector()

    DispatchQueue.concurrentPerform(iterations: fixtures.count) { index in
      if index.isMultiple(of: 2) {
        do {
          _ = try store.commitGeneration(
            hostIdentity: "stage-host",
            buildId: fixtures[index].buildId,
            manifestJson: fixtures[index].manifestJson
          )
        } catch {
          failures.append(error)
        }
      } else {
        store.abortGeneration(hostIdentity: "stage-host", buildId: fixtures[index].buildId)
      }
    }
    precondition(failures.isEmpty)

    for index in stride(from: 1, to: fixtures.count, by: 2) {
      precondition(
        mobileWebStoreThrows {
          _ = try store.openSession(
            hostIdentity: "stage-host",
            buildId: fixtures[index].buildId,
            bridgeVersion: 1
          )
        }
      )
    }
    let generations = mobileWebStoreHostRoot(cacheRoot: root, host: "stage-host")
      .appendingPathComponent("generations")
    let retained = try FileManager.default.contentsOfDirectory(atPath: generations.path)
    precondition(retained.count == 1)
    precondition(
      fixtures.enumerated().contains {
        $0.offset.isMultiple(of: 2) && $0.element.buildId == retained[0]
      }
    )
    try store.removeHost(hostIdentity: "stage-host")
    let hostRoot = mobileWebStoreHostRoot(cacheRoot: root, host: "stage-host")
    precondition(!FileManager.default.fileExists(atPath: hostRoot.path))
  }
}

private final class ConcurrentFailureCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var failures = [String]()

  var isEmpty: Bool {
    lock.lock()
    defer { lock.unlock() }
    return failures.isEmpty
  }

  func append(_ error: Error) {
    lock.lock()
    failures.append(error.localizedDescription)
    lock.unlock()
  }
}
