import ExpoModulesCore
import UserNotifications

public class OrcaNotificationDismissalSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    guard let payload = userInfo["orca"] as? [String: Any],
      payload["kind"] as? String == "dismiss", let fence = PushDismissalIdentity(payload)
    else { completionHandler(.noData); return }
    PushDismissalLedger.shared.remember(fence)
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { notifications in
      let ids = notifications.compactMap { notification -> String? in
        guard let data = notification.request.content.userInfo["orca"] as? [String: Any],
          data["hostFingerprint"] as? String == fence.hostFingerprint,
          PushDismissalLedger.shared.containsNotification(data) else { return nil }
        return notification.request.identifier
      }
      center.removeDeliveredNotifications(withIdentifiers: ids)
      completionHandler(ids.isEmpty ? .noData : .newData)
    }
  }
}
