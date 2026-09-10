import Foundation
@main struct PushDismissalLedgerChecks {
 static func main() {
  let suite = "orca.qa.dismissal." + UUID().uuidString
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  func payload(_ seq: Int, _ host: String = "qa-host", _ epoch: String = "qa-epoch", _ id: String = "qa-alert") -> [String: Any] {
   ["hostFingerprint": host, "notificationId": id, "notificationEpoch": epoch, "notificationSeq": seq]
  }
  func identity(_ seq: Int, _ host: String = "qa-host", _ epoch: String = "qa-epoch", _ id: String = "qa-alert") -> PushDismissalIdentity {
   PushDismissalIdentity(payload(seq, host, epoch, id))!
  }
  let ledger = PushDismissalLedger(defaults: defaults)
  ledger.remember(identity(2), now: 100)
  ledger.remember(identity(1), now: 101)
  let restored = PushDismissalLedger(defaults: defaults)
  precondition(restored.contains(identity(1), now: 102))
  precondition(restored.contains(identity(2), now: 102))
  precondition(!restored.contains(identity(3), now: 102))
  precondition(!restored.contains(identity(1, "other"), now: 102))
  precondition(!restored.contains(identity(1, "qa-host", "other"), now: 102))
  precondition(!restored.contains(identity(1, "qa-host", "qa-epoch", "other"), now: 102))
  precondition(!restored.contains(identity(1), now: 86501))
  precondition(PushDismissalIdentity(["hostFingerprint":"h", "notificationId":"n", "notificationEpoch":"e", "notificationSeq":true]) == nil)
  precondition(restored.containsNotification(payload(1), now: 102))
  precondition(!restored.containsNotification(payload(3), now: 102))
  precondition(!restored.containsNotification(payload(1, "other"), now: 102))
  precondition(!restored.containsNotification(payload(1, "qa-host", "other"), now: 102))
  precondition(!restored.containsNotification(payload(1, "qa-host", "qa-epoch", "other"), now: 102))
  precondition(!restored.containsNotification(["hostFingerprint": "qa-host"], now: 102))
  print("Native persisted fence: restart, ordering, identity isolation, expiry and invalid sequence checks passed")
 }
}
