import Darwin
import Foundation

enum MobileWebPackageStoreProcessInterruptionTests {
  private static let childFlag = "--mobile-web-store-interruption-child"
  private static let hostIdentity = "paired-host"

  private enum Phase: String, CaseIterable {
    case assetStaged
    case generationCommitted
  }

  static func runIfChild() throws -> Bool {
    let arguments = CommandLine.arguments
    guard arguments.count == 4, arguments[1] == childFlag else { return false }
    guard let phase = Phase(rawValue: arguments[3]) else {
      throw ProcessInterruptionError.invalidPhase
    }
    try runChild(root: URL(fileURLWithPath: arguments[2], isDirectory: true), phase: phase)
    return true
  }

  static func verify(root: URL) throws {
    for phase in Phase.allCases {
      let phaseRoot = root.appendingPathComponent(phase.rawValue, isDirectory: true)
      let baseline = try mobileWebStoreFixture(content: "<!doctype html><title>Baseline</title>")
      let next = try mobileWebStoreFixture(content: "<!doctype html><title>Next</title>")
      let store = MobileWebPackageStore(cacheRoot: phaseRoot)
      try mobileWebStoreCommit(store: store, host: hostIdentity, fixture: baseline)

      try runKilledChild(root: phaseRoot, phase: phase)

      let reopened = MobileWebPackageStore(cacheRoot: phaseRoot)
      let active = try reopened.openSession(
        hostIdentity: hostIdentity,
        buildId: nil,
        bridgeVersion: 1
      )
      let expected = phase == .generationCommitted ? next : baseline
      precondition(active["buildId"] == expected.buildId)
      let asset = try reopened.readAsset(sessionId: active["sessionId"]!, path: "index.html")
      precondition(asset.data == expected.bytes)
      // A kill never leaves a staged tree behind for the next launch to trip over.
      let staging = mobileWebStoreHostRoot(cacheRoot: phaseRoot, host: hostIdentity)
        .appendingPathComponent("tmp")
      precondition(!FileManager.default.fileExists(atPath: staging.path))
    }
  }

  private static func runChild(root: URL, phase: Phase) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let next = try mobileWebStoreFixture(content: "<!doctype html><title>Next</title>")
    try mobileWebStoreStageAsset(store: store, host: hostIdentity, fixture: next)
    killIf(phase == .assetStaged)
    _ = try store.commitGeneration(
      hostIdentity: hostIdentity,
      buildId: next.buildId,
      manifestJson: next.manifestJson
    )
    killIf(phase == .generationCommitted)
    throw ProcessInterruptionError.invalidPhase
  }

  private static func runKilledChild(root: URL, phase: Phase) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = [childFlag, root.path, phase.rawValue]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    precondition(process.terminationReason == .uncaughtSignal)
    precondition(process.terminationStatus == SIGKILL)
  }

  private static func killIf(_ shouldKill: Bool) {
    guard shouldKill else { return }
    _ = Darwin.kill(Darwin.getpid(), SIGKILL)
    fatalError("SIGKILL failed")
  }
}

private enum ProcessInterruptionError: Error {
  case invalidPhase
}
