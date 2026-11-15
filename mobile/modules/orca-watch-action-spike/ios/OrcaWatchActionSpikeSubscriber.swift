import ExpoModulesCore
import ExpoNotifications
import UIKit
import UserNotifications

public class OrcaWatchActionSpikeSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    WatchActionSpikeLedger.shared.append(
      "launch",
      [
        "appState": WatchActionSpikeLedger.appState(application),
        "protectedData": application.isProtectedDataAvailable,
      ])
    NotificationCenterManager.shared.addDelegate(WatchActionSpikeResponseObserver.shared)
    return true
  }
}

/// Records each spike action tap natively and holds background time, since Expo completes the response at once.
final class WatchActionSpikeResponseObserver: NotificationDelegate {
  static let shared = WatchActionSpikeResponseObserver()

  private var hold: UIBackgroundTaskIdentifier = .invalid
  private var holdStartedAt = Date()

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    let request = response.notification.request
    guard request.content.categoryIdentifier == WatchActionSpikeLedger.category else {
      return false
    }
    let application = UIApplication.shared
    var fields: [String: Any] = [
      "notificationId": request.identifier,
      "action": response.actionIdentifier,
      "appState": WatchActionSpikeLedger.appState(application),
      "protectedData": application.isProtectedDataAvailable,
      "deliveredAt": response.notification.date.timeIntervalSince1970 * 1000,
    ]
    if let text = (response as? UNTextInputNotificationResponse)?.userText {
      fields["replyChars"] = text.count
    }
    WatchActionSpikeLedger.shared.append("response", fields)
    beginHold()
    // Not handled: Expo's emitter must still deliver the response to JS.
    return false
  }

  func beginHold() {
    DispatchQueue.main.async {
      guard self.hold == .invalid else { return }
      self.holdStartedAt = Date()
      self.hold = UIApplication.shared.beginBackgroundTask(withName: WatchActionSpikeLedger.category) {
        self.endHold(reason: "expired")
      }
      WatchActionSpikeLedger.shared.append(
        "hold-started",
        ["remainingSec": UIApplication.shared.backgroundTimeRemaining])
    }
  }

  func endHold(reason: String) {
    DispatchQueue.main.async {
      guard self.hold != .invalid else { return }
      WatchActionSpikeLedger.shared.append(
        "hold-ended",
        ["reason": reason, "heldMs": Date().timeIntervalSince(self.holdStartedAt) * 1000])
      UIApplication.shared.endBackgroundTask(self.hold)
      self.hold = .invalid
    }
  }
}
