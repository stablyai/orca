import Foundation
import UIKit

/// Native timeline of launches and action taps; it survives a launch in which JS never runs.
final class WatchActionSpikeLedger {
  static let shared = WatchActionSpikeLedger()
  static let category = "orca.watch-spike"

  private let key = "orca.watchSpike.events"
  private let limit = 80
  private let lock = NSLock()

  func append(_ kind: String, _ fields: [String: Any] = [:]) {
    var event = fields
    event["kind"] = kind
    event["at"] = Date().timeIntervalSince1970 * 1000
    lock.lock()
    defer { lock.unlock() }
    var events = UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []
    events.append(event)
    UserDefaults.standard.set(Array(events.suffix(limit)), forKey: key)
  }

  func events() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    UserDefaults.standard.removeObject(forKey: key)
  }

  static func appState(_ application: UIApplication) -> String {
    switch application.applicationState {
    case .active: return "active"
    case .inactive: return "inactive"
    case .background: return "background"
    @unknown default: return "unknown"
    }
  }
}
