import ExpoModulesCore

public class OrcaNotificationDismissalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaNotificationDismissal")
    AsyncFunction("rememberAll") { (payloads: [[String: Any]]) in
      PushDismissalLedger.shared.remember(payloads.compactMap(PushDismissalIdentity.init))
    }
    AsyncFunction("wasDismissed") { (payload: [String: Any]) -> Bool in
      guard let identity = PushDismissalIdentity(payload) else { return false }
      return PushDismissalLedger.shared.contains(identity)
    }
  }
}
