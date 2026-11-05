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

  struct Key: Hashable { let host: String; let id: String; let epoch: String }
  var key: Key { Key(host: hostFingerprint, id: notificationId, epoch: notificationEpoch) }

  func matches(_ other: PushDismissalIdentity) -> Bool { key == other.key }
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
    remember([identity], now: now)
  }

  // One read/encode/write per batch keeps catch-up pages linear in ledger size.
  func remember(_ identities: [PushDismissalIdentity], now: TimeInterval = Date().timeIntervalSince1970) {
    guard !identities.isEmpty else { return }
    lock.lock(); defer { lock.unlock() }
    let entries = read(now: now)
    var order: [PushDismissalIdentity.Key] = []
    var newest: [PushDismissalIdentity.Key: PushDismissalIdentity] = [:]
    for identity in identities {
      if let current = newest[identity.key] {
        if current.notificationSeq <= identity.notificationSeq { newest[identity.key] = identity }
      } else {
        order.append(identity.key); newest[identity.key] = identity
      }
    }
    var kept: [Entry] = []
    for entry in entries {
      guard let batch = newest[entry.identity.key] else { kept.append(entry); continue }
      if entry.identity.notificationSeq > batch.notificationSeq { newest[entry.identity.key] = entry.identity }
    }
    // Keep every live fence: count-based eviction lets delayed alerts reappear.
    let next = kept + order.compactMap { key in newest[key].map { Entry(identity: $0, expiresAt: now + 86400) } }
    if let data = try? JSONEncoder().encode(next) {
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
