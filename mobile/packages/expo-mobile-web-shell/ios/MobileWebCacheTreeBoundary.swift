import Foundation

func removeMobileWebCacheTree(_ entry: URL, within cacheRoot: URL) throws {
  let fileManager = FileManager.default
  let parent = entry.deletingLastPathComponent()
  guard isMobileWebUnlinkedPath(parent, within: cacheRoot) else {
    throw MobileWebStoreError("mobile_web_cache_boundary_invalid")
  }
  let isSymbolicLink = (try? fileManager.destinationOfSymbolicLink(atPath: entry.path)) != nil
  guard fileManager.fileExists(atPath: entry.path) || isSymbolicLink else { return }
  guard isMobileWebUnlinkedPath(entry, within: cacheRoot) else {
    try fileManager.removeItem(at: entry)
    return
  }
  let values = try entry.resourceValues(forKeys: [.isDirectoryKey])
  if values.isDirectory == true {
    for child in try fileManager.contentsOfDirectory(
      at: entry,
      includingPropertiesForKeys: nil
    ) {
      try removeMobileWebCacheTree(child, within: cacheRoot)
    }
  }
  try fileManager.removeItem(at: entry)
}

func mobileWebCacheLogicalByteLength(_ entry: URL, within cacheRoot: URL) throws -> Int64 {
  guard
    FileManager.default.fileExists(atPath: entry.path),
    isMobileWebUnlinkedPath(entry, within: cacheRoot)
  else { return 0 }
  let values = try entry.resourceValues(
    forKeys: [.isDirectoryKey, .isRegularFileKey, .fileSizeKey]
  )
  if values.isRegularFile == true { return Int64(values.fileSize ?? 0) }
  guard values.isDirectory == true else { return 0 }
  return try FileManager.default.contentsOfDirectory(
    at: entry,
    includingPropertiesForKeys: nil
  ).reduce(Int64(0)) { total, child in
    total + (try mobileWebCacheLogicalByteLength(child, within: cacheRoot))
  }
}
