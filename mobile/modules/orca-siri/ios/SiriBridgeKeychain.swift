import Foundation
import Security

public struct SiriBridgeConfiguration: Codable, Sendable {
  public let url: URL
  public let token: String
}

/// Bridge URL and token, stored once from the app's settings and read by Siri intents.
/// AfterFirstUnlock: Siri in CarPlay runs intents while the phone is locked.
/// ThisDeviceOnly: the token never goes to iCloud Keychain or backups.
public enum SiriBridgeKeychain {
  static let service = "dev.orca.siri-bridge"
  static let account = "configuration"

  private static var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  public static func load() -> SiriBridgeConfiguration? {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return try? JSONDecoder().decode(SiriBridgeConfiguration.self, from: data)
  }

  public static func save(_ configuration: SiriBridgeConfiguration) throws {
    let data = try JSONEncoder().encode(configuration)
    SecItemDelete(baseQuery as CFDictionary)
    var item = baseQuery
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw NSError(
        domain: NSOSStatusErrorDomain, code: Int(status),
        userInfo: [NSLocalizedDescriptionKey: "Keychain save failed (\(status))"])
    }
  }

  public static func clear() {
    SecItemDelete(baseQuery as CFDictionary)
  }
}
