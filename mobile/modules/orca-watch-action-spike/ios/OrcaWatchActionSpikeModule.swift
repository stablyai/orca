import ExpoModulesCore
import Security
import UIKit

public class OrcaWatchActionSpikeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaWatchActionSpike")

    AsyncFunction("readEvents") { () -> [[String: Any]] in
      WatchActionSpikeLedger.shared.events()
    }

    AsyncFunction("clearEvents") {
      WatchActionSpikeLedger.shared.clear()
    }

    AsyncFunction("endHold") {
      WatchActionSpikeResponseObserver.shared.endHold(reason: "js-done")
    }

    AsyncFunction("isProtectedDataAvailable") { () -> Bool in
      UIApplication.shared.isProtectedDataAvailable
    }.runOnQueue(.main)

    // Only the pairing keychain uses WhenUnlockedThisDeviceOnly, so the class filter selects exactly its items.
    AsyncFunction("setPairingKeychainReadableWhileLocked") { (enabled: Bool) -> [String: Any] in
      let locked = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      let afterFirstUnlock = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      return Self.moveGenericPasswords(
        from: enabled ? locked : afterFirstUnlock,
        to: enabled ? afterFirstUnlock : locked)
    }
  }

  private static func moveGenericPasswords(from: CFString, to: CFString) -> [String: Any] {
    let match: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccessible as String: from,
    ]
    var counted = match
    counted[kSecMatchLimit as String] = kSecMatchLimitAll
    counted[kSecReturnAttributes as String] = true
    var found: CFTypeRef?
    let countStatus = SecItemCopyMatching(counted as CFDictionary, &found)
    let count = (found as? [[String: Any]])?.count ?? 0
    guard countStatus == errSecSuccess, count > 0 else {
      return ["updated": 0, "status": Int(countStatus)]
    }
    let status = SecItemUpdate(
      match as CFDictionary, [kSecAttrAccessible as String: to] as CFDictionary)
    return ["updated": status == errSecSuccess ? count : 0, "status": Int(status)]
  }
}
