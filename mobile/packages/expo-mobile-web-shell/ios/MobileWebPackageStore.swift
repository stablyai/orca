import CryptoKit
import Foundation
import Security

private let chunkByteLimit = 48 * 1024
private let chunkBase64CharacterLimit = ((chunkByteLimit + 2) / 3) * 4
private let manifestJsonByteLimit = 256 * 1024
private let activationJsonByteLimit = 1024
private let assetByteLimit = 10 * 1024 * 1024
private let sha256Pattern = "^[a-f0-9]{64}$"
private let safePathPattern = "^[A-Za-z0-9._/-]+$"
private let assetMetadataByExtension: [String: (String, String)] = [
  "css": ("text/css; charset=utf-8", "style"),
  "js": ("text/javascript; charset=utf-8", "script"),
  "png": ("image/png", "image"),
  "svg": ("image/svg+xml; charset=utf-8", "image"),
  "wasm": ("application/wasm", "wasm"),
  "webp": ("image/webp", "image"),
  "woff2": ("font/woff2", "font"),
]

struct MobileWebAssetRecord {
  let path: String
  let sha256: String
  let byteLength: Int
  let contentType: String
  let role: String
}

struct MobileWebManifestRecord {
  let buildId: String
  let bridgeMinimum: Int
  let bridgeTestedThrough: Int
  let entrypoint: String
  let assets: [String: MobileWebAssetRecord]
}

struct MobileWebAssetResponse {
  let data: Data
  let contentType: String
  let isDocument: Bool
}

private final class MobileWebSessionRecord {
  let hostKey: String
  let buildId: String
  let bridgeVersion: Int
  let root: URL
  let manifest: MobileWebManifestRecord

  init(
    hostKey: String,
    buildId: String,
    bridgeVersion: Int,
    root: URL,
    manifest: MobileWebManifestRecord
  ) {
    self.hostKey = hostKey
    self.buildId = buildId
    self.bridgeVersion = bridgeVersion
    self.root = root
    self.manifest = manifest
  }
}

private final class MobileWebStageRecord {
  let hostKey: String
  let root: URL
  let manifest: MobileWebManifestRecord
  let reservedByteLength: Int64
  var finishedPaths = Set<String>()

  init(
    hostKey: String,
    root: URL,
    manifest: MobileWebManifestRecord,
    reservedByteLength: Int64
  ) {
    self.hostKey = hostKey
    self.root = root
    self.manifest = manifest
    self.reservedByteLength = reservedByteLength
  }
}

final class MobileWebPackageStore {
  private let fileManager = FileManager.default
  private let lock = NSLock()
  private let cacheRootOverride: URL?
  private let availableStorageBytes: (URL) -> Int64?
  private var stages = [String: MobileWebStageRecord]()
  private var sessions = [String: MobileWebSessionRecord]()

  init(
    cacheRoot rootOverride: URL? = nil,
    availableStorageBytes: @escaping (URL) -> Int64? = mobileWebAvailableStorageBytes
  ) {
    cacheRootOverride = rootOverride
    self.availableStorageBytes = availableStorageBytes
    guard let root = try? cacheRoot() else { return }
    try? cleanupOrphanedWrites(cacheRoot: root)
  }

  func beginStage(
    hostIdentity: String,
    manifestJson: String,
    canonicalManifestJson: String
  ) throws -> String {
    try locked {
      guard !hostIdentity.isEmpty, hostIdentity.utf8.count <= 8 * 1024 else {
        throw MobileWebStoreError("mobile_web_host_identity_invalid")
      }
      let manifest = try parseManifest(
        manifestJson: manifestJson,
        canonicalManifestJson: canonicalManifestJson
      )
      let hostKey = sha256Hex(Data(hostIdentity.utf8))
      let stageId = try randomIdentifier()
      let root = try cacheRoot()
      try cleanupOrphanedWrites(cacheRoot: root)
      let reservedByteLength = Int64(
        manifest.assets.values.reduce(0) { $0 + $1.byteLength }
          + manifestJson.utf8.count
          + canonicalManifestJson.utf8.count
      )
      try reserveCacheCapacity(
        cacheRoot: root,
        hostKey: hostKey,
        requestedBytes: reservedByteLength
      )
      let stageRoot =
        root
        .appendingPathComponent(hostKey, isDirectory: true)
        .appendingPathComponent("staging", isDirectory: true)
        .appendingPathComponent(stageId, isDirectory: true)
      do {
        guard isMobileWebUnlinkedPath(stageRoot, within: root) else {
          throw MobileWebStoreError("mobile_web_stage_create_failed")
        }
        try fileManager.createDirectory(at: stageRoot, withIntermediateDirectories: true)
        guard isMobileWebUnlinkedPath(stageRoot, within: root) else {
          throw MobileWebStoreError("mobile_web_stage_create_failed")
        }
        try Data(manifestJson.utf8).write(
          to: stageRoot.appendingPathComponent("manifest.json"),
          options: .atomic
        )
        try Data(canonicalManifestJson.utf8).write(
          to: stageRoot.appendingPathComponent("canonical-manifest.json"),
          options: .atomic
        )
        for asset in manifest.assets.values {
          let file = assetUrl(root: stageRoot, path: asset.path)
          try fileManager.createDirectory(
            at: file.deletingLastPathComponent(),
            withIntermediateDirectories: true
          )
          guard fileManager.createFile(atPath: file.path, contents: nil) else {
            throw MobileWebStoreError("mobile_web_stage_create_failed")
          }
        }
      } catch {
        try? removeMobileWebCacheTree(stageRoot, within: root)
        throw storageError(error, fallback: "mobile_web_stage_create_failed")
      }
      stages[stageId] = MobileWebStageRecord(
        hostKey: hostKey,
        root: stageRoot,
        manifest: manifest,
        reservedByteLength: reservedByteLength
      )
      return stageId
    }
  }

  func writeAssetChunk(
    stageId: String,
    path: String,
    offset: Int,
    dataBase64: String,
    chunkSha256: String
  ) throws {
    try locked {
      let stage = try requireStage(stageId)
      guard let asset = stage.manifest.assets[path], !stage.finishedPaths.contains(path) else {
        throw MobileWebStoreError("mobile_web_stage_asset_unknown")
      }
      guard
        dataBase64.utf8.count <= chunkBase64CharacterLimit,
        let bytes = Data(base64Encoded: dataBase64),
        bytes.base64EncodedString() == dataBase64,
        !bytes.isEmpty,
        bytes.count <= chunkByteLimit,
        isMobileWebSha256(chunkSha256),
        sha256Hex(bytes) == chunkSha256
      else {
        throw MobileWebStoreError("mobile_web_stage_chunk_invalid")
      }
      let file = assetUrl(root: stage.root, path: path)
      try requireMobileWebRegularFile(
        file,
        within: try cacheRoot(),
        errorCode: "mobile_web_stage_write_failed"
      )
      let currentLength = try fileManager.attributesOfItem(atPath: file.path)[.size] as? NSNumber
      guard
        offset >= 0,
        currentLength?.intValue == offset,
        offset + bytes.count <= asset.byteLength
      else {
        throw MobileWebStoreError("mobile_web_stage_offset_invalid")
      }
      do {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: bytes)
      } catch {
        throw storageError(error, fallback: "mobile_web_stage_write_failed")
      }
    }
  }

  func finishAsset(stageId: String, path: String) throws {
    try locked {
      let stage = try requireStage(stageId)
      guard let asset = stage.manifest.assets[path], !stage.finishedPaths.contains(path) else {
        throw MobileWebStoreError("mobile_web_stage_asset_unknown")
      }
      let file = assetUrl(root: stage.root, path: path)
      let bytes = try readMobileWebFile(
        file,
        within: try cacheRoot(),
        byteLimit: asset.byteLength,
        overflowCode: "mobile_web_stage_asset_invalid"
      )
      guard bytes.count == asset.byteLength, sha256Hex(bytes) == asset.sha256 else {
        throw MobileWebStoreError("mobile_web_stage_asset_invalid")
      }
      let handle = try FileHandle(forWritingTo: file)
      try handle.synchronize()
      try handle.close()
      stage.finishedPaths.insert(path)
    }
  }

  func commitStage(stageId: String) throws -> String {
    try locked {
      let stage = try requireStage(stageId)
      guard stage.finishedPaths.count == stage.manifest.assets.count else {
        throw MobileWebStoreError("mobile_web_stage_incomplete")
      }
      let root = try cacheRoot()
      let hostRoot = root.appendingPathComponent(stage.hostKey, isDirectory: true)
      let generations = hostRoot.appendingPathComponent("generations", isDirectory: true)
      let destination = generations.appendingPathComponent(
        stage.manifest.buildId,
        isDirectory: true
      )
      guard
        isMobileWebUnlinkedPath(hostRoot, within: root),
        isMobileWebUnlinkedPath(generations, within: root),
        isMobileWebUnlinkedPath(stage.root, within: root),
        isMobileWebUnlinkedPath(destination, within: root)
      else {
        throw MobileWebStoreError("mobile_web_generation_commit_failed")
      }
      try fileManager.createDirectory(at: generations, withIntermediateDirectories: true)
      guard isMobileWebUnlinkedPath(generations, within: root) else {
        throw MobileWebStoreError("mobile_web_generation_commit_failed")
      }
      do {
        var reuseExisting = false
        if fileManager.fileExists(atPath: destination.path) {
          let existing = try? verifyGeneration(destination)
          reuseExisting = existing?.buildId == stage.manifest.buildId
          if !reuseExisting {
            // A verified re-download must repair corrupt assets and persisted manifests.
            try removeMobileWebCacheTree(destination, within: root)
          }
        }
        if reuseExisting {
          try removeMobileWebCacheTree(stage.root, within: root)
        } else {
          try fileManager.moveItem(at: stage.root, to: destination)
        }
      } catch {
        throw storageError(error, fallback: "mobile_web_generation_commit_failed")
      }
      stages.removeValue(forKey: stageId)
      return stage.manifest.buildId
    }
  }

  func abortStage(stageId: String) {
    locked {
      guard let stage = stages.removeValue(forKey: stageId) else { return }
      guard let root = try? cacheRoot() else { return }
      try? removeMobileWebCacheTree(stage.root, within: root)
    }
  }

  func openSession(
    hostIdentity: String,
    buildId: String?,
    bridgeVersion: Int
  ) throws -> [String: String] {
    try locked {
      let hostKey = try validatedHostKey(hostIdentity)
      let root = try cacheRoot()
      let hostRoot = root.appendingPathComponent(hostKey, isDirectory: true)
      if let buildId {
        guard isMobileWebSha256(buildId) else {
          throw MobileWebStoreError("mobile_web_generation_invalid")
        }
        guard isMobileWebUnlinkedPath(hostRoot, within: root) else {
          throw MobileWebStoreError("mobile_web_generation_invalid")
        }
        return try openVerifiedSession(
          hostKey: hostKey,
          hostRoot: hostRoot,
          buildId: buildId,
          bridgeVersion: bridgeVersion
        )
      }
      guard isMobileWebUnlinkedPath(hostRoot, within: root) else {
        throw MobileWebStoreError("mobile_web_activation_invalid")
      }
      let activation = try readActivation(hostRoot: hostRoot)
      do {
        return try openVerifiedSession(
          hostKey: hostKey,
          hostRoot: hostRoot,
          buildId: activation.active,
          bridgeVersion: bridgeVersion
        )
      } catch {
        guard let previous = activation.previous, previous != activation.active else {
          throw error
        }
        return try openVerifiedSession(
          hostKey: hostKey,
          hostRoot: hostRoot,
          buildId: previous,
          bridgeVersion: bridgeVersion,
          activateFallback: true
        )
      }
    }
  }

  private func openVerifiedSession(
    hostKey: String,
    hostRoot: URL,
    buildId: String,
    bridgeVersion: Int,
    activateFallback: Bool = false
  ) throws -> [String: String] {
    let cacheRoot = try cacheRoot()
    guard isMobileWebUnlinkedPath(hostRoot, within: cacheRoot) else {
      throw MobileWebStoreError("mobile_web_generation_invalid")
    }
    let selectedBuildId = buildId
    let generationRoot =
      hostRoot
      .appendingPathComponent("generations", isDirectory: true)
      .appendingPathComponent(selectedBuildId, isDirectory: true)
    let manifest = try verifyGeneration(generationRoot)
    guard manifest.buildId == selectedBuildId else {
      throw MobileWebStoreError("mobile_web_generation_invalid")
    }
    try requireCompatibleBridge(manifest: manifest, bridgeVersion: bridgeVersion)
    guard isMobileWebUnlinkedPath(generationRoot, within: cacheRoot) else {
      throw MobileWebStoreError("mobile_web_generation_invalid")
    }
    if activateFallback {
      try writeActivation(
        MobileWebActivationRecord(active: selectedBuildId, previous: nil),
        hostRoot: hostRoot
      )
    }
    try? fileManager.setAttributes(
      [.modificationDate: Date()],
      ofItemAtPath: generationRoot.path
    )
    let sessionId = try randomIdentifier()
    sessions[sessionId] = MobileWebSessionRecord(
      hostKey: hostKey,
      buildId: selectedBuildId,
      bridgeVersion: bridgeVersion,
      root: generationRoot,
      manifest: manifest
    )
    if activateFallback {
      try? removeUnusedGenerations(hostRoot: hostRoot, active: selectedBuildId, previous: nil)
    }
    return sessionResponse(
      sessionId: sessionId,
      buildId: selectedBuildId,
      entrypoint: manifest.entrypoint
    )
  }

  func recoverSession(sessionId: String) throws -> [String: String] {
    try locked {
      guard let failed = sessions[sessionId] else {
        throw MobileWebStoreError("mobile_web_session_unknown")
      }
      let root = try cacheRoot()
      let hostRoot = root.appendingPathComponent(failed.hostKey, isDirectory: true)
      guard isMobileWebUnlinkedPath(hostRoot, within: root) else {
        throw MobileWebStoreError("mobile_web_activation_invalid")
      }
      let activation = try readActivation(hostRoot: hostRoot)
      let fallbackBuildId: String
      let fallbackPrevious: String?
      if activation.active == failed.buildId {
        guard let previous = activation.previous, previous != failed.buildId else {
          throw MobileWebStoreError("mobile_web_recovery_unavailable")
        }
        fallbackBuildId = previous
        fallbackPrevious = nil
      } else {
        fallbackBuildId = activation.active
        fallbackPrevious = activation.previous
      }
      let generationRoot =
        hostRoot
        .appendingPathComponent("generations", isDirectory: true)
        .appendingPathComponent(fallbackBuildId, isDirectory: true)
      let manifest = try verifyGeneration(generationRoot)
      guard manifest.buildId == fallbackBuildId, fallbackBuildId != failed.buildId else {
        throw MobileWebStoreError("mobile_web_recovery_unavailable")
      }
      try requireCompatibleBridge(manifest: manifest, bridgeVersion: failed.bridgeVersion)
      let recoveredSessionId = try randomIdentifier()
      if activation.active == failed.buildId {
        try writeActivation(
          MobileWebActivationRecord(active: fallbackBuildId, previous: nil),
          hostRoot: hostRoot
        )
      }
      sessions.removeValue(forKey: sessionId)
      sessions[recoveredSessionId] = MobileWebSessionRecord(
        hostKey: failed.hostKey,
        buildId: fallbackBuildId,
        bridgeVersion: failed.bridgeVersion,
        root: generationRoot,
        manifest: manifest
      )
      try? removeUnusedGenerations(
        hostRoot: hostRoot,
        active: fallbackBuildId,
        previous: fallbackPrevious
      )
      return sessionResponse(
        sessionId: recoveredSessionId,
        buildId: fallbackBuildId,
        entrypoint: manifest.entrypoint
      )
    }
  }

  func markSessionHealthy(sessionId: String) throws -> String {
    try locked {
      guard let session = sessions[sessionId] else {
        throw MobileWebStoreError("mobile_web_session_unknown")
      }
      let root = try cacheRoot()
      let hostRoot = root.appendingPathComponent(session.hostKey, isDirectory: true)
      guard isMobileWebUnlinkedPath(hostRoot, within: root) else {
        throw MobileWebStoreError("mobile_web_activation_write_failed")
      }
      let current = try? readActivation(hostRoot: hostRoot)
      let previous = current?.active == session.buildId ? current?.previous : current?.active
      try writeActivation(
        MobileWebActivationRecord(active: session.buildId, previous: previous),
        hostRoot: hostRoot
      )
      try removeUnusedGenerations(hostRoot: hostRoot, active: session.buildId, previous: previous)
      return session.buildId
    }
  }

  func closeSession(sessionId: String) {
    locked {
      _ = sessions.removeValue(forKey: sessionId)
    }
  }

  func readAsset(sessionId: String, path: String) throws -> MobileWebAssetResponse {
    try locked {
      guard let session = sessions[sessionId], let asset = session.manifest.assets[path] else {
        throw MobileWebStoreError("mobile_web_asset_unavailable")
      }
      let file = assetUrl(root: session.root, path: asset.path)
      let data: Data
      do {
        data = try readMobileWebFile(
          file,
          within: try cacheRoot(),
          byteLimit: asset.byteLength,
          overflowCode: "mobile_web_generation_invalid"
        )
      } catch {
        throw MobileWebStoreError("mobile_web_generation_invalid")
      }
      guard data.count == asset.byteLength, sha256Hex(data) == asset.sha256 else {
        throw MobileWebStoreError("mobile_web_generation_invalid")
      }
      return MobileWebAssetResponse(
        data: data,
        contentType: asset.contentType,
        isDocument: asset.role == "document"
      )
    }
  }

  func removeHost(hostIdentity: String) throws {
    try locked {
      guard !hostIdentity.isEmpty, hostIdentity.utf8.count <= 8 * 1024 else {
        throw MobileWebStoreError("mobile_web_host_identity_invalid")
      }
      let hostKey = try validatedHostKey(hostIdentity)
      let matchingStageIds = stages.compactMap { stageId, stage in
        stage.hostKey == hostKey ? stageId : nil
      }
      for stageId in matchingStageIds {
        stages.removeValue(forKey: stageId)
      }
      let matchingSessionIds = sessions.compactMap { sessionId, session in
        session.hostKey == hostKey ? sessionId : nil
      }
      for sessionId in matchingSessionIds {
        sessions.removeValue(forKey: sessionId)
      }
      let cacheRoot = try cacheRoot()
      let hostRoot = cacheRoot.appendingPathComponent(hostKey, isDirectory: true)
      do {
        try removeMobileWebCacheTree(hostRoot, within: cacheRoot)
      } catch {
        throw MobileWebStoreError("mobile_web_host_cleanup_failed")
      }
    }
  }

  private func parseManifest(
    manifestJson: String,
    canonicalManifestJson: String
  ) throws -> MobileWebManifestRecord {
    guard
      manifestJson.utf8.count <= manifestJsonByteLimit,
      canonicalManifestJson.utf8.count <= manifestJsonByteLimit,
      isExactMobileWebJsonDocument(manifestJson),
      isExactMobileWebJsonDocument(canonicalManifestJson),
      let manifest = try jsonObject(manifestJson) as? [String: Any],
      let canonical = try jsonObject(canonicalManifestJson) as? [String: Any],
      Set(manifest.keys)
        == Set(["schemaVersion", "buildId", "bridge", "entrypoint", "totalBytes", "assets"]),
      strictJsonInt(manifest["schemaVersion"]) == 1,
      let buildId = manifest["buildId"] as? String,
      isMobileWebSha256(buildId),
      sha256Hex(Data(canonicalManifestJson.utf8)) == buildId,
      let bridge = manifest["bridge"] as? [String: Any],
      Set(bridge.keys) == Set(["minimum", "testedThrough"]),
      let bridgeMinimum = strictJsonInt(bridge["minimum"]),
      let bridgeTestedThrough = strictJsonInt(bridge["testedThrough"]),
      bridgeMinimum > 0,
      bridgeMinimum <= bridgeTestedThrough,
      bridgeTestedThrough <= 65_535,
      let entrypoint = manifest["entrypoint"] as? String,
      let declaredTotalBytes = strictJsonInt(manifest["totalBytes"]),
      declaredTotalBytes > 0,
      declaredTotalBytes <= 32 * 1024 * 1024,
      let assets = manifest["assets"] as? [[String: Any]],
      !assets.isEmpty,
      assets.count <= 256
    else {
      throw MobileWebStoreError("mobile_web_stage_manifest_invalid")
    }
    var expected = manifest
    expected.removeValue(forKey: "buildId")
    guard NSDictionary(dictionary: expected).isEqual(to: canonical) else {
      throw MobileWebStoreError("mobile_web_stage_manifest_invalid")
    }
    var records = [String: MobileWebAssetRecord]()
    var totalBytes = 0
    var documentCount = 0
    var previousPath: String?
    for value in assets {
      guard
        Set(value.keys) == Set(["path", "sha256", "byteLength", "contentType", "role"]),
        let path = value["path"] as? String,
        let hash = value["sha256"] as? String,
        let length = strictJsonInt(value["byteLength"]),
        let contentType = value["contentType"] as? String,
        let role = value["role"] as? String,
        isSafeMobileWebAssetPath(path),
        isMobileWebSha256(hash),
        length > 0,
        length <= assetByteLimit,
        records[path] == nil,
        previousPath == nil || previousPath! < path,
        isValidMobileWebAssetMetadata(
          path: path,
          hash: hash,
          contentType: contentType,
          role: role
        )
      else {
        throw MobileWebStoreError("mobile_web_stage_manifest_invalid")
      }
      records[path] = MobileWebAssetRecord(
        path: path,
        sha256: hash,
        byteLength: length,
        contentType: contentType,
        role: role
      )
      totalBytes += length
      documentCount += role == "document" ? 1 : 0
      previousPath = path
    }
    guard
      totalBytes == declaredTotalBytes,
      (1...2).contains(documentCount),
      entrypoint == "index.html",
      records[entrypoint] != nil,
      assets.contains(where: {
        $0["path"] as? String == entrypoint && $0["role"] as? String == "document"
      })
    else {
      throw MobileWebStoreError("mobile_web_stage_manifest_invalid")
    }
    return MobileWebManifestRecord(
      buildId: buildId,
      bridgeMinimum: bridgeMinimum,
      bridgeTestedThrough: bridgeTestedThrough,
      entrypoint: entrypoint,
      assets: records
    )
  }

  private func requireCompatibleBridge(
    manifest: MobileWebManifestRecord,
    bridgeVersion: Int
  ) throws {
    guard
      bridgeVersion >= manifest.bridgeMinimum,
      bridgeVersion <= manifest.bridgeTestedThrough
    else {
      throw MobileWebStoreError("mobile_web_bridge_incompatible")
    }
  }

  private func verifyCommittedGeneration(
    _ root: URL,
    manifest: MobileWebManifestRecord
  ) throws {
    for asset in manifest.assets.values {
      let bytes = try readMobileWebFile(
        assetUrl(root: root, path: asset.path),
        within: try cacheRoot(),
        byteLimit: asset.byteLength,
        overflowCode: "mobile_web_generation_invalid"
      )
      guard bytes.count == asset.byteLength, sha256Hex(bytes) == asset.sha256 else {
        throw MobileWebStoreError("mobile_web_generation_invalid")
      }
    }
  }

  private func verifyGeneration(_ root: URL) throws -> MobileWebManifestRecord {
    do {
      let manifestData = try readMobileWebFile(
        root.appendingPathComponent("manifest.json"),
        within: try cacheRoot(),
        byteLimit: manifestJsonByteLimit,
        overflowCode: "mobile_web_generation_invalid"
      )
      let canonicalManifestData = try readMobileWebFile(
        root.appendingPathComponent("canonical-manifest.json"),
        within: try cacheRoot(),
        byteLimit: manifestJsonByteLimit,
        overflowCode: "mobile_web_generation_invalid"
      )
      guard
        let manifestJson = String(data: manifestData, encoding: .utf8),
        let canonicalManifestJson = String(data: canonicalManifestData, encoding: .utf8)
      else {
        throw MobileWebStoreError("mobile_web_generation_invalid")
      }
      let manifest = try parseManifest(
        manifestJson: manifestJson,
        canonicalManifestJson: canonicalManifestJson
      )
      try verifyCommittedGeneration(root, manifest: manifest)
      return manifest
    } catch {
      throw MobileWebStoreError("mobile_web_generation_invalid")
    }
  }

  private func readActivation(hostRoot: URL) throws -> MobileWebActivationRecord {
    do {
      let root = try cacheRoot()
      guard isMobileWebUnlinkedPath(hostRoot, within: root) else {
        throw MobileWebStoreError("mobile_web_activation_invalid")
      }
      let data = try readMobileWebFile(
        hostRoot.appendingPathComponent("activation.json"),
        within: root,
        byteLimit: activationJsonByteLimit,
        overflowCode: "mobile_web_activation_invalid"
      )
      guard let activation = parseMobileWebActivationRecord(data) else {
        throw MobileWebStoreError("mobile_web_activation_invalid")
      }
      return activation
    } catch {
      throw MobileWebStoreError("mobile_web_activation_invalid")
    }
  }

  private func writeActivation(_ activation: MobileWebActivationRecord, hostRoot: URL) throws {
    let root = try cacheRoot()
    guard isMobileWebUnlinkedPath(hostRoot, within: root) else {
      throw MobileWebStoreError("mobile_web_activation_write_failed")
    }
    try fileManager.createDirectory(at: hostRoot, withIntermediateDirectories: true)
    let values = try hostRoot.resourceValues(forKeys: [.isDirectoryKey])
    guard
      isMobileWebUnlinkedPath(hostRoot, within: root),
      values.isDirectory == true
    else {
      throw MobileWebStoreError("mobile_web_activation_write_failed")
    }
    let data = try JSONEncoder().encode(activation)
    try data.write(to: hostRoot.appendingPathComponent("activation.json"), options: .atomic)
  }

  private func removeUnusedGenerations(
    hostRoot: URL,
    active: String,
    previous: String?
  ) throws {
    let sessionBuilds = Set(
      sessions.values.filter { $0.hostKey == hostRoot.lastPathComponent }.map(\.buildId)
    )
    let retained = sessionBuilds.union([active, previous].compactMap { $0 })
    let generations = hostRoot.appendingPathComponent("generations", isDirectory: true)
    let root = try cacheRoot()
    guard isMobileWebUnlinkedPath(hostRoot, within: root) else {
      throw MobileWebStoreError("mobile_web_generation_cleanup_failed")
    }
    guard
      let children = try? fileManager.contentsOfDirectory(
        at: generations,
        includingPropertiesForKeys: nil
      )
    else { return }
    for child in children where !retained.contains(child.lastPathComponent) {
      do {
        try removeMobileWebCacheTree(child, within: root)
      } catch {
        throw MobileWebStoreError("mobile_web_generation_cleanup_failed")
      }
    }
  }

  private func reserveCacheCapacity(
    cacheRoot: URL,
    hostKey: String,
    requestedBytes: Int64
  ) throws {
    let hostRoot = cacheRoot.appendingPathComponent(hostKey, isDirectory: true)
    let stageReservations = try stages.values.map { stage in
      (
        stage: stage,
        remaining: max(0, stage.reservedByteLength - (try logicalByteLength(of: stage.root)))
      )
    }
    let hostStageReservations =
      stageReservations
      .filter { $0.stage.hostKey == hostKey }
      .reduce(Int64(0)) { $0 + $1.remaining }
    let allStageReservations = stageReservations.reduce(Int64(0)) { $0 + $1.remaining }
    let projectedHostBytes =
      try logicalByteLength(of: hostRoot)
      + hostStageReservations
      + requestedBytes
    let projectedGlobalBytes =
      try logicalByteLength(of: cacheRoot)
      + allStageReservations
      + requestedBytes
    let candidates = try evictionCandidates(cacheRoot: cacheRoot)
    guard
      let plan = mobileWebCacheEvictionPlan(
        candidates: candidates,
        targetHostKey: hostKey,
        projectedHostBytes: projectedHostBytes,
        projectedGlobalBytes: projectedGlobalBytes
      )
    else {
      throw MobileWebStoreError("mobile_web_cache_quota_exceeded")
    }
    for candidate in plan {
      do {
        try removeMobileWebCacheTree(candidate.root, within: cacheRoot)
      } catch {
        throw MobileWebStoreError("mobile_web_cache_quota_exceeded")
      }
    }

    let available = availableStorageBytes(cacheRoot)
    let reservedFreeBytes = allStageReservations + requestedBytes
    if let available, available < reservedFreeBytes + mobileWebMinimumFreeStorageBytes {
      throw MobileWebStoreError("mobile_web_cache_storage_unavailable")
    }
  }

  private func evictionCandidates(
    cacheRoot: URL
  ) throws -> [MobileWebCacheGenerationCandidate] {
    let hostRoots = try fileManager.contentsOfDirectory(
      at: cacheRoot,
      includingPropertiesForKeys: [.isDirectoryKey]
    ).filter {
      isMobileWebSha256($0.lastPathComponent)
        && isMobileWebUnlinkedPath($0, within: cacheRoot)
        && (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
    }
    var candidates = [MobileWebCacheGenerationCandidate]()
    for hostRoot in hostRoots {
      let generationsRoot = hostRoot.appendingPathComponent("generations", isDirectory: true)
      guard
        let generationRoots = try? fileManager.contentsOfDirectory(
          at: generationsRoot,
          includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey]
        ).filter({
          isMobileWebSha256($0.lastPathComponent)
            && isMobileWebUnlinkedPath($0, within: cacheRoot)
            && (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        })
      else { continue }
      let buildIds = Set(generationRoots.map(\.lastPathComponent))
      var protected = Set(
        sessions.values.filter { $0.hostKey == hostRoot.lastPathComponent }.map(\.buildId)
      )
      let activationUrl = hostRoot.appendingPathComponent("activation.json")
      if fileManager.fileExists(atPath: activationUrl.path) {
        do {
          let activation = try readActivation(hostRoot: hostRoot)
          protected.insert(activation.active)
          if let previous = activation.previous { protected.insert(previous) }
        } catch {
          // Why: unreadable activation state must fail closed instead of deleting a possible rollback.
          protected.formUnion(buildIds)
        }
      }
      for generationRoot in generationRoots
      where !protected.contains(generationRoot.lastPathComponent) {
        let values = try generationRoot.resourceValues(forKeys: [.contentModificationDateKey])
        candidates.append(
          MobileWebCacheGenerationCandidate(
            hostKey: hostRoot.lastPathComponent,
            buildId: generationRoot.lastPathComponent,
            byteLength: try logicalByteLength(of: generationRoot),
            modifiedAt: values.contentModificationDate ?? .distantPast,
            root: generationRoot
          )
        )
      }
    }
    return candidates
  }

  private func cleanupOrphanedWrites(cacheRoot: URL) throws {
    let liveStageRoots = Set(stages.values.map { $0.root.standardizedFileURL.path })
    guard
      let hostRoots = try? fileManager.contentsOfDirectory(
        at: cacheRoot,
        includingPropertiesForKeys: [.isDirectoryKey]
      )
    else { return }
    do {
      for hostRoot in hostRoots where isMobileWebSha256(hostRoot.lastPathComponent) {
        if !isMobileWebUnlinkedPath(hostRoot, within: cacheRoot) {
          try removeMobileWebCacheTree(hostRoot, within: cacheRoot)
          continue
        }
        let stagingRoot = hostRoot.appendingPathComponent("staging", isDirectory: true)
        if let stagedRoots = try? fileManager.contentsOfDirectory(
          at: stagingRoot,
          includingPropertiesForKeys: [.isDirectoryKey]
        ) {
          for stagedRoot in stagedRoots
          where !liveStageRoots.contains(stagedRoot.standardizedFileURL.path)
            || !isMobileWebUnlinkedPath(stagedRoot, within: cacheRoot)
          {
            try removeMobileWebCacheTree(stagedRoot, within: cacheRoot)
          }
        }
      }
    } catch {
      throw MobileWebStoreError("mobile_web_cache_cleanup_failed")
    }
  }

  private func logicalByteLength(of root: URL) throws -> Int64 {
    try mobileWebCacheLogicalByteLength(root, within: cacheRoot())
  }

  private func validatedHostKey(_ hostIdentity: String) throws -> String {
    guard !hostIdentity.isEmpty, hostIdentity.utf8.count <= 8 * 1024 else {
      throw MobileWebStoreError("mobile_web_host_identity_invalid")
    }
    return sha256Hex(Data(hostIdentity.utf8))
  }

  private func sessionResponse(
    sessionId: String,
    buildId: String,
    entrypoint: String
  ) -> [String: String] {
    [
      "sessionId": sessionId,
      "buildId": buildId,
      "url": "orca-mobile-web://\(sessionId)/",
    ]
  }

  private func requireStage(_ stageId: String) throws -> MobileWebStageRecord {
    guard let stage = stages[stageId] else {
      throw MobileWebStoreError("mobile_web_stage_unknown")
    }
    return stage
  }

  private func cacheRoot() throws -> URL {
    if let cacheRootOverride {
      try fileManager.createDirectory(at: cacheRootOverride, withIntermediateDirectories: true)
      return cacheRootOverride
    }
    let support = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    var root = support.appendingPathComponent("OrcaMobileWeb", isDirectory: true)
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try root.setResourceValues(values)
    return root
  }

  private func assetUrl(root: URL, path: String) -> URL {
    path.split(separator: "/").reduce(root) { url, component in
      url.appendingPathComponent(String(component), isDirectory: false)
    }
  }

  private func locked<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

#if !MOBILE_WEB_PACKAGE_STORE_TESTING
  let sharedMobileWebPackageStore = MobileWebPackageStore()
#endif

struct MobileWebStoreError: LocalizedError {
  let code: String

  var errorDescription: String? { code }

  init(_ code: String) {
    self.code = code
  }
}

private func storageError(_ error: Error, fallback: String) -> MobileWebStoreError {
  if let storeError = error as? MobileWebStoreError { return storeError }
  let code = isStorageUnavailable(error) ? "mobile_web_cache_storage_unavailable" : fallback
  return MobileWebStoreError(code)
}

private func mobileWebAvailableStorageBytes(_ root: URL) -> Int64? {
  try? root.resourceValues(
    forKeys: [.volumeAvailableCapacityForImportantUsageKey]
  ).volumeAvailableCapacityForImportantUsage
}

private func isStorageUnavailable(_ error: Error) -> Bool {
  let value = error as NSError
  if value.domain == NSCocoaErrorDomain && value.code == NSFileWriteOutOfSpaceError {
    return true
  }
  if value.domain == NSPOSIXErrorDomain && value.code == 28 { return true }
  if let underlying = value.userInfo[NSUnderlyingErrorKey] as? Error {
    return isStorageUnavailable(underlying)
  }
  return false
}

private func jsonObject(_ value: String) throws -> Any {
  try JSONSerialization.jsonObject(with: Data(value.utf8), options: [.fragmentsAllowed])
}

func isMobileWebSha256(_ value: String) -> Bool {
  value.range(of: sha256Pattern, options: .regularExpression) == value.startIndex..<value.endIndex
}

private func strictJsonInt(_ value: Any?) -> Int? {
  guard
    let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID()
  else {
    return nil
  }
  return Int(exactly: number.doubleValue)
}

func isSafeMobileWebAssetPath(_ path: String) -> Bool {
  guard
    (1...240).contains(path.count),
    !path.hasPrefix("/"),
    !path.hasSuffix("/"),
    !path.contains("//"),
    !path.contains("\\"),
    !path.contains("?"),
    !path.contains("#"),
    path.range(of: safePathPattern, options: .regularExpression) == path.startIndex..<path.endIndex
  else {
    return false
  }
  return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
    $0 != "." && $0 != ".."
  }
}

func isValidMobileWebAssetMetadata(
  path: String,
  hash: String,
  contentType: String,
  role: String
) -> Bool {
  guard isSafeMobileWebAssetPath(path), isMobileWebSha256(hash) else {
    return false
  }
  if role == "document" {
    return (path == "index.html" || path == "mermaid-frame.html")
      && contentType == "text/html; charset=utf-8"
  }
  let components = path.split(separator: "/")
  guard
    components.count == 2,
    components[0] == "assets",
    let separator = components[1].lastIndex(of: ".")
  else {
    return false
  }
  let filenameHash = String(components[1][..<separator])
  let fileExtension = String(components[1][components[1].index(after: separator)...])
  guard let expected = assetMetadataByExtension[fileExtension] else { return false }
  return filenameHash == hash && expected.0 == contentType && expected.1 == role
}

private func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func randomIdentifier() throws -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    throw MobileWebStoreError("mobile_web_random_identifier_failed")
  }
  return Data(bytes).base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}
