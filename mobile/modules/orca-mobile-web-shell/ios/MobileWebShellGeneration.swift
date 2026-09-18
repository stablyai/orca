import Foundation

struct MobileWebShellAsset {
  let file: URL
  let contentType: String
}

enum MobileWebShellGenerationError: Error {
  case unreadable
}

/// The served surface of one activated generation: a request path to file map, built once from the
/// manifest before anything loads. Serving is a lookup in this map and never a path join at request
/// time, so "not in the manifest" is a refusal by construction rather than by sanitiser.
///
/// Asset bytes are not re-hashed here. The TypeScript store verified every byte against the
/// manifest before the activating rename, and the directory path is one the app owns and the page
/// can never influence. Framework-free so `swiftc` can check it.
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
    // Removed, not copied: the document answers at "/" and nowhere else, so the one response that
    // carries the policy header is the only way to reach those bytes.
    guard let document = entries.removeValue(forKey: "/\(entrypoint)") else {
      throw MobileWebShellGenerationError.unreadable
    }
    entries["/"] = document
    // The manifest is written last and is not part of the content hash, so it is not in `assets`;
    // the bootstrap page still reads it from its own origin.
    entries["/\(manifestName)"] = MobileWebShellAsset(
      file: directory.appendingPathComponent(manifestName, isDirectory: false),
      contentType: manifestContentType
    )
    return MobileWebShellGeneration(entries: entries)
  }

  /// `as? Int` is not this check: NSNumber bridges `true` and `1.0` to 1, and the contract pins the
  /// integer 1. JSONSerialization keeps the written form, so the number's own type answers it.
  static func isPinnedSchemaVersion(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return false
    }
    let numberType = String(cString: number.objCType)
    guard numberType != "d", numberType != "f" else { return false }
    return number.intValue == schemaVersion
  }

  /// Re-checked here rather than trusted: the schema that pins this shape is on the other side of
  /// a file the native layer cannot see change.
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

  /// This value becomes a response header, so it must not be able to carry a second header or a
  /// parameter we did not intend. One lowercase type, one optional charset: the manifest
  /// contract's only accepted spelling.
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
