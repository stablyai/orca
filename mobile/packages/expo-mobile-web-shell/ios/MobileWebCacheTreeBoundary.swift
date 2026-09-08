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
