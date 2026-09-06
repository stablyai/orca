import CryptoKit
import Darwin
import Foundation

enum MobileWebPackageStoreProcessInterruptionTests {
  private static let childFlag = "--mobile-web-store-interruption-child"
  private static let hostIdentity = "paired-host"

  private enum Phase: String, CaseIterable {
    case stageCreated
    case chunkWritten
    case assetFinished
    case generationCommitted
    case activationReplaced
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
      let baseline = try fixture(content: "<!doctype html><title>Baseline</title>")
      let next = try fixture(content: "<!doctype html><title>Next</title>")
      let store = MobileWebPackageStore(cacheRoot: phaseRoot)
      try stage(store: store, fixture: baseline)
      let baselineSession = try store.openSession(
        hostIdentity: hostIdentity,
        buildId: baseline.buildId,
        bridgeVersion: 1
      )
      _ = try store.markSessionHealthy(sessionId: baselineSession["sessionId"]!)

      try runKilledChild(root: phaseRoot, phase: phase)

      let reopened = MobileWebPackageStore(cacheRoot: phaseRoot)
      let active = try reopened.openSession(
        hostIdentity: hostIdentity,
        buildId: nil,
        bridgeVersion: 1
      )
      if phase == .activationReplaced {
        precondition(active["buildId"] == next.buildId)
        let recovered = try reopened.recoverSession(sessionId: active["sessionId"]!)
        precondition(recovered["buildId"] == baseline.buildId)
      } else {
        precondition(active["buildId"] == baseline.buildId)
      }
      let staging =
        phaseRoot
        .appendingPathComponent(interruptionSha256(Data(hostIdentity.utf8)))
        .appendingPathComponent("staging")
      let staged = try? FileManager.default.contentsOfDirectory(atPath: staging.path)
      precondition(staged?.isEmpty != false)
    }
  }

  private static func runChild(root: URL, phase: Phase) throws {
    let store = MobileWebPackageStore(cacheRoot: root)
    let next = try fixture(content: "<!doctype html><title>Next</title>")
    let stageId = try store.beginStage(
      hostIdentity: hostIdentity,
      manifestJson: next.manifest,
      canonicalManifestJson: next.canonical
    )
    killIf(phase == .stageCreated)
    try store.writeAssetChunk(
      stageId: stageId,
      path: "index.html",
      offset: 0,
      dataBase64: next.bytes.base64EncodedString(),
      chunkSha256: interruptionSha256(next.bytes)
    )
    killIf(phase == .chunkWritten)
    try store.finishAsset(stageId: stageId, path: "index.html")
    killIf(phase == .assetFinished)
    _ = try store.commitStage(stageId: stageId)
    killIf(phase == .generationCommitted)
    let session = try store.openSession(
      hostIdentity: hostIdentity,
      buildId: next.buildId,
      bridgeVersion: 1
    )
    _ = try store.markSessionHealthy(sessionId: session["sessionId"]!)
    killIf(phase == .activationReplaced)
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

  private static func stage(store: MobileWebPackageStore, fixture: InterruptionFixture) throws {
    let stageId = try store.beginStage(
      hostIdentity: hostIdentity,
      manifestJson: fixture.manifest,
      canonicalManifestJson: fixture.canonical
    )
    try store.writeAssetChunk(
      stageId: stageId,
      path: "index.html",
      offset: 0,
      dataBase64: fixture.bytes.base64EncodedString(),
      chunkSha256: interruptionSha256(fixture.bytes)
    )
    try store.finishAsset(stageId: stageId, path: "index.html")
    _ = try store.commitStage(stageId: stageId)
  }

  private static func fixture(content: String) throws -> InterruptionFixture {
    let bytes = Data(content.utf8)
    let canonical: [String: Any] = [
      "schemaVersion": 1,
      "bridge": ["minimum": 1, "testedThrough": 1],
      "entrypoint": "index.html",
      "totalBytes": bytes.count,
      "assets": [
        [
          "path": "index.html",
          "sha256": interruptionSha256(bytes),
          "byteLength": bytes.count,
          "contentType": "text/html; charset=utf-8",
          "role": "document",
        ]
      ],
    ]
    let canonicalData = try JSONSerialization.data(
      withJSONObject: canonical, options: [.sortedKeys])
    let buildId = interruptionSha256(canonicalData)
    var manifest = canonical
    manifest["buildId"] = buildId
    let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    return InterruptionFixture(
      bytes: bytes,
      canonical: String(decoding: canonicalData, as: UTF8.self),
      manifest: String(decoding: manifestData, as: UTF8.self),
      buildId: buildId
    )
  }
}

private struct InterruptionFixture {
  let bytes: Data
  let canonical: String
  let manifest: String
  let buildId: String
}

private enum ProcessInterruptionError: Error {
  case invalidPhase
}

private func interruptionSha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
