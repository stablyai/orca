import Foundation
import CoreFoundation

struct PushDismissalIdentity: Codable {
  let hostFingerprint: String
  let notificationId: String
  let notificationEpoch: String
  let notificationSeq: Int64

  init?(_ value: [String: Any]) {
    guard let host = value["hostFingerprint"] as? String, !host.isEmpty, host.count <= 512,
      let id = value["notificationId"] as? String, !id.isEmpty, id.count <= 2048,
      let epoch = value["notificationEpoch"] as? String, !epoch.isEmpty, epoch.count <= 128,
      let seq = value["notificationSeq"] as? NSNumber,
      CFGetTypeID(seq) != CFBooleanGetTypeID(), seq.doubleValue.isFinite,
      seq.doubleValue >= 0, seq.doubleValue <= 9_007_199_254_740_991,
      seq.doubleValue.rounded(.down) == seq.doubleValue else { return nil }
    hostFingerprint = host; notificationId = id; notificationEpoch = epoch
    notificationSeq = seq.int64Value
  }

  func matches(_ other: PushDismissalIdentity) -> Bool {
    hostFingerprint == other.hostFingerprint && notificationId == other.notificationId &&
      notificationEpoch == other.notificationEpoch
  }
}

final class PushDismissalLedger {
  static let shared = PushDismissalLedger()
  private struct Entry: Codable { let identity: PushDismissalIdentity; let expiresAt: TimeInterval }
  private let defaults: UserDefaults
  private let lock = NSLock()
  private let storageKey = "orca.pushDismissals.v1"
  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  private func read(now: TimeInterval) -> [Entry] {
    guard let data = defaults.data(forKey: storageKey),
      let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
    return entries.filter { $0.expiresAt > now }
  }

  func remember(_ identity: PushDismissalIdentity, now: TimeInterval = Date().timeIntervalSince1970) {
    lock.lock(); defer { lock.unlock() }
    let entries = read(now: now)
    let previous = entries.first { $0.identity.matches(identity) }
    let newest = (previous?.identity.notificationSeq ?? -1) > identity.notificationSeq
      ? previous!.identity : identity
    let next = entries.filter { !$0.identity.matches(identity) } +
      [Entry(identity: newest, expiresAt: now + 86400)]
    if let data = try? JSONEncoder().encode(Array(next.suffix(512))) {
      defaults.set(data, forKey: storageKey)
    }
  }

  func contains(_ identity: PushDismissalIdentity, now: TimeInterval = Date().timeIntervalSince1970) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return read(now: now).contains {
      $0.identity.matches(identity) && $0.identity.notificationSeq >= identity.notificationSeq
    }
  }

  func containsNotification(_ payload: [String: Any], now: TimeInterval = Date().timeIntervalSince1970) -> Bool {
    guard let identity = PushDismissalIdentity(payload) else { return false }
    return contains(identity, now: now)
  }
}
