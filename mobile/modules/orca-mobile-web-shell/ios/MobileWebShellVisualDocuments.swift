import Foundation

enum MobileWebShellVisualPolicy {
  static let prefix = "/_orca_visual/"
  static let csp = "default-src 'none'; script-src 'unsafe-inline'; " +
    "style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src 'none'; " +
    "frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; " +
    "form-action 'none'; base-uri 'none'; sandbox allow-scripts"
}

/// Main-thread, per-document memory; no caller paths or resources surviving a session change.
final class MobileWebShellVisualDocuments {
  private var entries: [String: Data] = [:]
  private var totalBytes = 0

  func create(_ html: String) throws -> String {
    let data = Data(html.utf8)
    guard data.count <= 1024 * 1024, entries.count < 32,
      totalBytes + data.count <= 16 * 1024 * 1024 else {
      throw CocoaError(.fileWriteOutOfSpace)
    }
    let path = "\(MobileWebShellVisualPolicy.prefix)\(UUID().uuidString.lowercased()).html"
    entries[path] = data
    totalBytes += data.count
    return path
  }

  func read(_ path: String) -> Data? { entries[path] }

  func remove(_ path: String) {
    guard let data = entries.removeValue(forKey: path) else { return }
    totalBytes -= data.count
  }

  func clear() {
    entries.removeAll()
    totalBytes = 0
  }
}
