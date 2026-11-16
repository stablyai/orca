import Foundation

struct MobileWebShellAsset {
  let file: URL
  let contentType: String
}

enum MobileWebShellGenerationError: Error {
  case unreadable
}

/// Serve only a prebuilt manifest path map, never request-time path joins. TypeScript verifies bytes before activation; native uses an app-owned directory.
struct MobileWebShellGeneration {
  static let manifestName = "manifest.json"
  static let manifestContentType = "application/json"
  static let schemaVersion = 1
  static let entrypoint = "index.html"
  static let maxAssets = 256
  static let maxAssetPathLength = 255
  static let maxContentTypeLength = 128

  let entries: [String: MobileWebShellAsset]

  static func load(directoryPath: String) throws -> MobileWebShellGeneration {
    guard directoryPath.hasPrefix("/") else { throw MobileWebShellGenerationError.unreadable }
    let directory = URL(fileURLWithPath: directoryPath, isDirectory: true)
    guard
      let data = try? Data(contentsOf: directory.appendingPathComponent(manifestName))
    else { throw MobileWebShellGenerationError.unreadable }
    return try make(manifestData: data, directory: directory)
  }

  static func make(manifestData: Data, directory: URL) throws -> MobileWebShellGeneration {
    let parsed = try? JSONSerialization.jsonObject(with: manifestData)
    guard
      let root = parsed as? [String: Any],
      isPinnedSchemaVersion(root["schemaVersion"]),
      let declaredEntrypoint = root["entrypoint"] as? String,
      declaredEntrypoint == entrypoint,
      let assets = root["assets"] as? [[String: Any]],
      !assets.isEmpty,
      assets.count <= maxAssets
    else { throw MobileWebShellGenerationError.unreadable }

    var entries: [String: MobileWebShellAsset] = [:]
    for asset in assets {
      guard
        let path = asset["path"] as? String,
        isServableAssetPath(path),
        let contentType = asset["contentType"] as? String,
        isServableContentType(contentType)
      else { throw MobileWebShellGenerationError.unreadable }
      entries["/\(path)"] = MobileWebShellAsset(
        file: directory.appendingPathComponent(path, isDirectory: false),
        contentType: contentType
      )
    }
    // Remove the entrypoint alias: only / may serve document bytes with the CSP header.
    guard let document = entries.removeValue(forKey: "/\(entrypoint)") else {
      throw MobileWebShellGenerationError.unreadable
    }
    entries["/"] = document
    // Bootstrap reads the last-written manifest, which is excluded from the content hash/assets.
    entries["/\(manifestName)"] = MobileWebShellAsset(
      file: directory.appendingPathComponent(manifestName, isDirectory: false),
      contentType: manifestContentType
    )
    return MobileWebShellGeneration(entries: entries)
  }

  /// NSNumber bridges true and 1.0 to Int; check JSON’s written number type to require integer 1.
  static func isPinnedSchemaVersion(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return false
    }
    let numberType = String(cString: number.objCType)
    guard numberType != "d", numberType != "f" else { return false }
    return number.intValue == schemaVersion
  }

  /// Revalidate the schema across the TypeScript/native file boundary.
  static func isServableAssetPath(_ path: String) -> Bool {
    guard !path.isEmpty, path.utf8.count <= maxAssetPathLength else { return false }
    for segment in path.split(separator: "/", omittingEmptySubsequences: false) {
      guard !segment.isEmpty, segment != ".", segment != ".." else { return false }
      let valid = segment.allSatisfy { character in
        character.isASCII &&
          (character.isLetter || character.isNumber || character == "." || character == "_" ||
            character == "-")
      }
      guard valid else { return false }
    }
    return true
  }

  /// Accept one lowercase MIME type and optional charset to prevent header/parameter injection.
  static func isServableContentType(_ contentType: String) -> Bool {
    guard !contentType.isEmpty, contentType.utf8.count <= maxContentTypeLength else { return false }
    var type = Substring(contentType)
    if let separator = contentType.range(of: "; charset=") {
      let charset = contentType[separator.upperBound...]
      let validCharset = !charset.isEmpty && charset.allSatisfy { character in
        character.isASCII &&
          (("a"..."z").contains(character) || ("0"..."9").contains(character) || character == "-")
      }
      guard validCharset else { return false }
      type = contentType[contentType.startIndex..<separator.lowerBound]
    }
    let halves = type.split(separator: "/", omittingEmptySubsequences: false)
    guard halves.count == 2 else { return false }
    return halves.allSatisfy(isMimeToken)
  }

  private static func isMimeToken(_ token: Substring) -> Bool {
    guard
      let first = token.first,
      first.isASCII,
      ("a"..."z").contains(first) || ("0"..."9").contains(first)
    else { return false }
    return token.allSatisfy { character in
      character.isASCII &&
        (("a"..."z").contains(character) || ("0"..."9").contains(character) ||
          character == "." || character == "+" || character == "-")
    }
  }
}
