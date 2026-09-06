import CryptoKit
import Foundation

enum MobileWebActivationMetadataTests {
  static func run(root: URL) throws {
    let active = String(repeating: "a", count: 64)
    let previous = String(repeating: "b", count: 64)
    let valid = [
      "{\"active\":\"\(active)\"}",
      "{\"active\":\"\(active)\",\"previous\":\"\(previous)\"}",
    ]
    precondition(
      valid.allSatisfy {
        parseMobileWebActivationRecord(Data($0.utf8)) != nil
      }
    )

    let numericHash = String(repeating: "1", count: 64)
    let invalid = [
      "[]",
      "{}",
      "{\"active\":null}",
      "{\"active\":true}",
      "{\"active\":\(numericHash)}",
      "{\"active\":\"\(active.uppercased())\"}",
      "{\"active\":\"\(active)\",\"previous\":null}",
      "{\"active\":\"\(active)\",\"previous\":true}",
      "{\"active\":\"\(active)\",\"previous\":\"\(active)\"}",
      "{\"active\":\"\(active)\",\"unexpected\":true}",
      "{\"active\":\"\(active)\",\"active\":\"\(active)\"}",
      "{\"active\":\"\(active)\"} trailing",
    ]
    precondition(
      invalid.allSatisfy {
        parseMobileWebActivationRecord(Data($0.utf8)) == nil
      }
    )

    let store = MobileWebPackageStore(cacheRoot: root)
    let hostRoot =
      root
      .appendingPathComponent(sha256Hex(Data("paired-host".utf8)))
    try FileManager.default.createDirectory(at: hostRoot, withIntermediateDirectories: true)
    for value in invalid {
      try Data(value.utf8).write(to: hostRoot.appendingPathComponent("activation.json"))
      precondition(
        throwsCode("mobile_web_activation_invalid") {
          _ = try store.openSession(
            hostIdentity: "paired-host",
            buildId: nil,
            bridgeVersion: 1
          )
        }
      )
    }
  }

  private static func throwsCode(_ code: String, _ body: () throws -> Void) -> Bool {
    do {
      try body()
      return false
    } catch {
      return error.localizedDescription == code
    }
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
