import CryptoKit
import Foundation
import Security

private let manifestJsonByteLimit = 256 * 1024
private let assetByteLimit = 10 * 1024 * 1024
private let assetBase64CharacterLimit = ((assetByteLimit + 2) / 3) * 4
private let maximumCachedHosts = 4
private let sha256Pattern = "^[a-f0-9]{64}$"
private let safePathPattern = "^[A-Za-z0-9._/-]+$"
private let manifestFileName = "manifest.json"
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
  let root: URL
  let manifest: MobileWebManifestRecord

  init(hostKey: String, buildId: String, root: URL, manifest: MobileWebManifestRecord) {
    self.hostKey = hostKey
    self.buildId = buildId
    self.root = root
    self.manifest = manifest
  }
}

final class MobileWebPackageStore {
  private let fileManager = FileManager.default
  private let lock = NSLock()
  private let cacheRootOverride: URL?
  private var sessions = [String: MobileWebSessionRecord]()

  init(cacheRoot rootOverride: URL? = nil) {
    cacheRootOverride = rootOverride
    guard let root = try? cacheRoot() else { return }
    try? discardAllStagedGenerations(cacheRoot: root)
  }

  /// Writes one complete asset. JS has already reassembled and sha256-verified the bytes.
  func writeStagedAsset(
    hostIdentity: String,
    buildId: String,
    path: String,
    dataBase64: String
  ) throws {
    try locked {
      let hostKey = try validatedHostKey(hostIdentity)
      guard
        isMobileWebSha256(buildId),
        isSafeMobileWebAssetPath(path),
        path != manifestFileName,
        dataBase64.utf8.count <= assetBase64CharacterLimit,
        let bytes = Data(base64Encoded: dataBase64),
        bytes.base64EncodedString() == dataBase64,
        !bytes.isEmpty,
        bytes.count <= assetByteLimit
      else {
        throw MobileWebStoreError("mobile_web_staged_asset_invalid")
      }
      let root = try cacheRoot()
      let stageRoot = try createdStagingRoot(cacheRoot: root, hostKey: hostKey, buildId: buildId)
      let file = assetUrl(root: stageRoot, path: path)
      do {
        try fileManager.createDirectory(
          at: file.deletingLastPathComponent(),
          withIntermediateDirectories: true
        )
        guard isMobileWebUnlinkedPath(file.deletingLastPathComponent(), within: root) else {
          throw MobileWebStoreError("mobile_web_staged_write_failed")
        }
        try bytes.write(to: file, options: .atomic)
      } catch {
        throw storageError(error, fallback: "mobile_web_staged_write_failed")
      }
    }
  }

  /// Promotes the staged tree to the host's only generation once every manifest asset verifies.
  @discardableResult
  func commitGeneration(hostIdentity: String, buildId: String, manifestJson: String) throws
    -> String
  {
    try locked {
      let hostKey = try validatedHostKey(hostIdentity)
      let manifest = try parseManifest(buildId: buildId, manifestJson: manifestJson)
      let root = try cacheRoot()
      let hostRoot = root.appendingPathComponent(hostKey, isDirectory: true)
      let generations = hostRoot.appendingPathComponent("generations", isDirectory: true)
      let destination = generations.appendingPathComponent(buildId, isDirectory: true)
      let stageRoot = stagingRoot(hostRoot: hostRoot, buildId: buildId)
      guard
        isMobileWebUnlinkedPath(hostRoot, within: root),
        isMobileWebUnlinkedPath(generations, within: root),
        isMobileWebUnlinkedPath(destination, within: root),
        isMobileWebUnlinkedPath(stageRoot, within: root)
      else {
        throw MobileWebStoreError("mobile_web_generation_commit_failed")
      }
      if (try? verifyGeneration(destination, buildId: buildId)) == nil {
        try promoteStagedGeneration(
          stageRoot: stageRoot,
          destination: destination,
          generations: generations,
          manifest: manifest,
          manifestJson: manifestJson,
          cacheRoot: root
        )
      }
      try? removeMobileWebCacheTree(stageRoot, within: root)
      try? removeOtherGenerations(
        generations: generations,
        hostKey: hostKey,
        keeping: buildId,
        cacheRoot: root
      )
      try? evictLeastRecentlyActivatedHosts(cacheRoot: root, keeping: hostKey)
      return buildId
    }
  }

  func abortGeneration(hostIdentity: String, buildId: String) {
    locked {
      guard
        let hostKey = try? validatedHostKey(hostIdentity),
        isMobileWebSha256(buildId),
        let root = try? cacheRoot()
      else {
        return
      }
      let hostRoot = root.appendingPathComponent(hostKey, isDirectory: true)
      try? removeMobileWebCacheTree(stagingRoot(hostRoot: hostRoot, buildId: buildId), within: root)
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
      let generations = hostRoot.appendingPathComponent("generations", isDirectory: true)
      guard
        isMobileWebUnlinkedPath(hostRoot, within: root),
        isMobileWebUnlinkedPath(generations, within: root)
      else {
        throw MobileWebStoreError("mobile_web_generation_invalid")
      }
      let selectedBuildId = try requestedBuildId(generations: generations, buildId: buildId)
      let generationRoot = generations.appendingPathComponent(selectedBuildId, isDirectory: true)
      guard isMobileWebUnlinkedPath(generationRoot, within: root) else {
        throw MobileWebStoreError("mobile_web_generation_invalid")
      }
      let manifest = try verifyGeneration(generationRoot, buildId: selectedBuildId)
      guard
        bridgeVersion >= manifest.bridgeMinimum,
        bridgeVersion <= manifest.bridgeTestedThrough
      else {
        throw MobileWebStoreError("mobile_web_bridge_incompatible")
      }
      // The host directory's modification time is the only activation record the LRU cap needs.
      try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: hostRoot.path)
      let sessionId = try randomIdentifier()
      sessions[sessionId] = MobileWebSessionRecord(
        hostKey: hostKey,
        buildId: selectedBuildId,
        root: generationRoot,
        manifest: manifest
      )
      return [
        "sessionId": sessionId,
        "buildId": selectedBuildId,
        "url": "orca-mobile-web://\(sessionId)/",
      ]
    }
  }

  func closeSession(sessionId: String) {
    locked {
      guard let session = sessions.removeValue(forKey: sessionId),
        let root = try? cacheRoot()
      else { return }
      let generations = root.appendingPathComponent(session.hostKey, isDirectory: true)
        .appendingPathComponent("generations", isDirectory: true)
      guard let newest = try? requestedBuildId(generations: generations, buildId: nil) else { return }
      try? removeOtherGenerations(
        generations: generations, hostKey: session.hostKey, keeping: newest, cacheRoot: root
      )
    }
  }

  func readAsset(sessionId: String, path: String) throws -> MobileWebAssetResponse {
    try locked {
      guard let session = sessions[sessionId], let asset = session.manifest.assets[path] else {
        throw MobileWebStoreError("mobile_web_asset_unavailable")
      }
      let data = try verifiedAssetBytes(root: session.root, asset: asset)
      return MobileWebAssetResponse(
        data: data,
        contentType: asset.contentType,
        isDocument: asset.role == "document"
      )
    }
  }

  func removeHost(hostIdentity: String) throws {
    try locked {
      let hostKey = try validatedHostKey(hostIdentity)
      for (sessionId, session) in sessions where session.hostKey == hostKey {
        sessions.removeValue(forKey: sessionId)
      }
      let root = try cacheRoot()
      do {
        try removeMobileWebCacheTree(
          root.appendingPathComponent(hostKey, isDirectory: true),
          within: root
        )
      } catch {
        throw MobileWebStoreError("mobile_web_host_cleanup_failed")
      }
    }
  }

  private func promoteStagedGeneration(
    stageRoot: URL,
    destination: URL,
    generations: URL,
    manifest: MobileWebManifestRecord,
    manifestJson: String,
    cacheRoot root: URL
  ) throws {
    try requireExactStagedTree(stageRoot, manifest: manifest, cacheRoot: root)
    do {
      try Data(manifestJson.utf8).write(
        to: stageRoot.appendingPathComponent(manifestFileName),
        options: .atomic
      )
      try fileManager.createDirectory(at: generations, withIntermediateDirectories: true)
      guard isMobileWebUnlinkedPath(generations, within: root) else {
        throw MobileWebStoreError("mobile_web_generation_commit_failed")
      }
      if fileManager.fileExists(atPath: destination.path) {
        try removeMobileWebCacheTree(destination, within: root)
      }
      try fileManager.moveItem(at: stageRoot, to: destination)
    } catch {
      throw storageError(error, fallback: "mobile_web_generation_commit_failed")
    }
  }

  /// A staged tree that carries anything the manifest does not name would survive the rename.
  private func requireExactStagedTree(
    _ stageRoot: URL,
    manifest: MobileWebManifestRecord,
    cacheRoot root: URL
  ) throws {
    guard
      isMobileWebUnlinkedPath(stageRoot, within: root),
      let walker = fileManager.enumerator(at: stageRoot, includingPropertiesForKeys: nil)
    else {
      throw MobileWebStoreError("mobile_web_staged_generation_incomplete")
    }
    let prefix = stageRoot.standardizedFileURL.path + "/"
    var staged = Set<String>()
    for case let entry as URL in walker {
      let values = try? entry.resourceValues(forKeys: [.isDirectoryKey])
      guard values?.isDirectory != true else { continue }
      staged.insert(String(entry.standardizedFileURL.path.dropFirst(prefix.count)))
    }
    guard staged == Set(manifest.assets.keys) else {
      throw MobileWebStoreError("mobile_web_staged_generation_incomplete")
    }
    for asset in manifest.assets.values {
      _ = try verifiedAssetBytes(root: stageRoot, asset: asset)
    }
  }

  private func verifiedAssetBytes(root: URL, asset: MobileWebAssetRecord) throws -> Data {
    let data: Data
    do {
      data = try readMobileWebFile(
        assetUrl(root: root, path: asset.path),
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
    return data
  }

  private func verifyGeneration(_ root: URL, buildId: String) throws -> MobileWebManifestRecord {
    do {
      let data = try readMobileWebFile(
        root.appendingPathComponent(manifestFileName),
        within: try cacheRoot(),
        byteLimit: manifestJsonByteLimit,
        overflowCode: "mobile_web_generation_invalid"
      )
      guard let manifestJson = String(data: data, encoding: .utf8) else {
        throw MobileWebStoreError("mobile_web_generation_invalid")
      }
      let manifest = try parseManifest(buildId: buildId, manifestJson: manifestJson)
      for asset in manifest.assets.values {
        _ = try verifiedAssetBytes(root: root, asset: asset)
      }
      return manifest
    } catch {
      throw MobileWebStoreError("mobile_web_generation_invalid")
    }
  }

  /// The build id is the sha256 of these exact manifest bytes, so the directory name authenticates
  /// the manifest and the manifest authenticates every asset.
  private func parseManifest(
    buildId: String,
    manifestJson: String
  ) throws -> MobileWebManifestRecord {
    guard
      isMobileWebSha256(buildId),
      manifestJson.utf8.count <= manifestJsonByteLimit,
      sha256Hex(Data(manifestJson.utf8)) == buildId,
      let manifest = try? JSONSerialization.jsonObject(with: Data(manifestJson.utf8))
        as? [String: Any],
      Set(manifest.keys) == Set(["schemaVersion", "bridge", "entrypoint", "totalBytes", "assets"]),
      strictJsonInt(manifest["schemaVersion"]) == 1,
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
      throw MobileWebStoreError("mobile_web_manifest_invalid")
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
        length > 0,
        length <= assetByteLimit,
        records[path] == nil,
        previousPath == nil || previousPath! < path,
        isValidMobileWebAssetMetadata(path: path, hash: hash, contentType: contentType, role: role)
      else {
        throw MobileWebStoreError("mobile_web_manifest_invalid")
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
      (1...mobileWebDocumentPaths.count).contains(documentCount),
      entrypoint == "index.html",
      records[entrypoint]?.role == "document"
    else {
      throw MobileWebStoreError("mobile_web_manifest_invalid")
    }
    return MobileWebManifestRecord(
      buildId: buildId,
      bridgeMinimum: bridgeMinimum,
      bridgeTestedThrough: bridgeTestedThrough,
      entrypoint: entrypoint,
      assets: records
    )
  }

  private func requestedBuildId(generations: URL, buildId: String?) throws -> String {
    if let buildId {
      guard isMobileWebSha256(buildId) else {
        throw MobileWebStoreError("mobile_web_generation_invalid")
      }
      return buildId
    }
    let candidates =
      (try? fileManager.contentsOfDirectory(
        at: generations,
        includingPropertiesForKeys: [.contentModificationDateKey]
      )) ?? []
    guard
      let newest = candidates
        .filter({ isMobileWebSha256($0.lastPathComponent) })
        .max(by: { modifiedAt($0) < modifiedAt($1) })
    else {
      throw MobileWebStoreError("mobile_web_generation_invalid")
    }
    return newest.lastPathComponent
  }

  private func removeOtherGenerations(
    generations: URL,
    hostKey: String,
    keeping buildId: String,
    cacheRoot: URL
  ) throws {
    let retained = Set(
      sessions.values.filter { $0.hostKey == hostKey }.map(\.buildId)
    ).union([buildId])
    guard
      let children = try? fileManager.contentsOfDirectory(
        at: generations,
        includingPropertiesForKeys: nil
      )
    else { return }
    for child in children where !retained.contains(child.lastPathComponent) {
      try removeMobileWebCacheTree(child, within: cacheRoot)
    }
  }

  private func evictLeastRecentlyActivatedHosts(cacheRoot root: URL, keeping hostKey: String) throws
  {
    let live = Set(sessions.values.map(\.hostKey)).union([hostKey])
    let hostRoots = try fileManager.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.contentModificationDateKey]
    ).filter { isMobileWebSha256($0.lastPathComponent) }
    let overflow = hostRoots.count - maximumCachedHosts
    guard overflow > 0 else { return }
    let evictable = hostRoots
      .filter { !live.contains($0.lastPathComponent) }
      .sorted { modifiedAt($0) < modifiedAt($1) }
    for hostRoot in evictable.prefix(overflow) {
      try removeMobileWebCacheTree(hostRoot, within: root)
    }
  }

  private func discardAllStagedGenerations(cacheRoot root: URL) throws {
    guard
      let hostRoots = try? fileManager.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: nil
      )
    else { return }
    for hostRoot in hostRoots where isMobileWebSha256(hostRoot.lastPathComponent) {
      guard isMobileWebUnlinkedPath(hostRoot, within: root) else {
        try removeMobileWebCacheTree(hostRoot, within: root)
        continue
      }
      try removeMobileWebCacheTree(
        hostRoot.appendingPathComponent("tmp", isDirectory: true),
        within: root
      )
    }
  }

  private func createdStagingRoot(cacheRoot root: URL, hostKey: String, buildId: String) throws
    -> URL
  {
    let hostRoot = root.appendingPathComponent(hostKey, isDirectory: true)
    let staging = hostRoot.appendingPathComponent("tmp", isDirectory: true)
    let stageRoot = staging.appendingPathComponent(buildId, isDirectory: true)
    // Creating intermediates first would build the stage *through* a symlinked ancestor before any
    // later check could reject it.
    guard
      isMobileWebUnlinkedPath(hostRoot, within: root),
      isMobileWebUnlinkedPath(staging, within: root),
      isMobileWebUnlinkedPath(stageRoot, within: root)
    else {
      throw MobileWebStoreError("mobile_web_staged_write_failed")
    }
    do {
      try fileManager.createDirectory(at: stageRoot, withIntermediateDirectories: true)
    } catch {
      throw storageError(error, fallback: "mobile_web_staged_write_failed")
    }
    guard isMobileWebUnlinkedPath(stageRoot, within: root) else {
      throw MobileWebStoreError("mobile_web_staged_write_failed")
    }
    return stageRoot
  }

  private func stagingRoot(hostRoot: URL, buildId: String) -> URL {
    hostRoot
      .appendingPathComponent("tmp", isDirectory: true)
      .appendingPathComponent(buildId, isDirectory: true)
  }

  private func modifiedAt(_ url: URL) -> Date {
    (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
      .flatMap { $0 } ?? .distantPast
  }

  private func validatedHostKey(_ hostIdentity: String) throws -> String {
    guard !hostIdentity.isEmpty, hostIdentity.utf8.count <= 8 * 1024 else {
      throw MobileWebStoreError("mobile_web_host_identity_invalid")
    }
    return sha256Hex(Data(hostIdentity.utf8))
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

private let mobileWebDocumentPaths: Set<String> = [
  "index.html",
  "markdown-editor.html",
  "mermaid-frame.html"
]

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
    return mobileWebDocumentPaths.contains(path) && contentType == "text/html; charset=utf-8"
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
