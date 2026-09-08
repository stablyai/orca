import Foundation

enum MobileWebCacheFileBoundaryTests {
  static func run(root: URL) throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let regular = root.appendingPathComponent("regular")
    try Data("valid".utf8).write(to: regular)
    let bytes = try readMobileWebFile(
      regular,
      within: root,
      byteLimit: 5,
      overflowCode: "mobile_web_generation_invalid"
    )
    precondition(bytes == Data("valid".utf8))

    let outside = root.deletingLastPathComponent().appendingPathComponent("outside")
    try Data("valid".utf8).write(to: outside)
    defer { try? FileManager.default.removeItem(at: outside) }
    try assertRejected(outside, within: root)

    let fileLink = root.appendingPathComponent("file-link")
    try FileManager.default.createSymbolicLink(at: fileLink, withDestinationURL: outside)
    try assertRejected(fileLink, within: root)

    let externalDirectory = root.deletingLastPathComponent().appendingPathComponent("external-dir")
    try FileManager.default.createDirectory(
      at: externalDirectory,
      withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: externalDirectory) }
    try Data("valid".utf8).write(to: externalDirectory.appendingPathComponent("asset"))
    let directoryLink = root.appendingPathComponent("directory-link")
    try FileManager.default.createSymbolicLink(
      at: directoryLink,
      withDestinationURL: externalDirectory
    )
    try assertRejected(directoryLink.appendingPathComponent("asset"), within: root)

    let directory = root.appendingPathComponent("directory")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try assertRejected(directory, within: root)
    try assertRejected(root.appendingPathComponent("missing"), within: root)
  }

  private static func assertRejected(_ file: URL, within root: URL) throws {
    precondition(
      throwsCode("mobile_web_generation_invalid") {
        _ = try readMobileWebFile(
          file,
          within: root,
          byteLimit: 5,
          overflowCode: "mobile_web_generation_invalid"
        )
      }
    )
  }

  private static func throwsCode(_ code: String, _ body: () throws -> Void) -> Bool {
    do {
      try body()
      return false
    } catch {
      return error.localizedDescription == code
    }
  }
}
