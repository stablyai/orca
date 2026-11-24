import Foundation

/// Application Support, which iOS never purges; the builds can be downloaded again, so backups skip them.
enum MobileWebShellGenerationStoreDirectory {
  static func prepare(name: String) throws -> String {
    var directory = try FileManager.default
      .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    return directory.absoluteString
  }
}
