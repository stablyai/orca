import ExpoNotifications
import UIKit
import UserNotifications

final class NotificationReplyBackgroundExecution: NSObject, NotificationDelegate {
  static let shared = NotificationReplyBackgroundExecution()
  private var pending: [String: [String: Any]] = NotificationReplyBackgroundExecution.loadPending()
  private var tasks: [String: UIBackgroundTaskIdentifier] = [:]

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    guard response.actionIdentifier == "orca.reply.send",
      let reply = response as? UNTextInputNotificationResponse else { return false }
    let request = response.notification.request
    let retainResponse = {
      let id = UUID().uuidString
      self.pending[id] = [
        "nativeReplyId": id,
        "actionIdentifier": response.actionIdentifier,
        "userText": reply.userText,
        "notification": ["request": [
          "identifier": request.identifier,
          "content": ["data": request.content.userInfo]
        ]]
      ]
      self.savePending()
      self.tasks[id] = UIApplication.shared.beginBackgroundTask(withName: "Orca notification reply") {
        self.endAssertion(id)
      }
    }
    if Thread.isMainThread {
      retainResponse()
    } else {
      DispatchQueue.main.sync(execute: retainResponse)
    }
    // Expo owns the notification completion; the background assertion covers the paired send.
    return false
  }

  private static var pendingURL: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("orca-pending-notification-replies.json")
  }

  private static func loadPending() -> [String: [String: Any]] {
    guard let data = try? Data(contentsOf: pendingURL),
      let replies = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]]
    else { return [:] }
    return replies
  }

  private func savePending() {
    do {
      let url = Self.pendingURL
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      let data = try JSONSerialization.data(withJSONObject: pending)
      // Data Protection keeps cold-launch replies encrypted until the first device unlock.
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      var excluded = url
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try excluded.setResourceValues(values)
    } catch {
      NSLog("Orca could not persist pending notification replies")
    }
  }

  func responses() -> [[String: Any]] { Array(pending.values) }

  func finish(_ id: String) {
    pending.removeValue(forKey: id)
    savePending()
    endAssertion(id)
  }

  private func endAssertion(_ id: String) {
    if let task = tasks.removeValue(forKey: id), task != .invalid {
      UIApplication.shared.endBackgroundTask(task)
    }
  }
}
