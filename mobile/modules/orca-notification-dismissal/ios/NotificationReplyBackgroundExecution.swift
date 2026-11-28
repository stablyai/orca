import ExpoNotifications
import UIKit
import UserNotifications

final class NotificationReplyBackgroundExecution: NSObject, NotificationDelegate {
  static let shared = NotificationReplyBackgroundExecution()
  private var pending: [String: [String: Any]] = [:]
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
      self.tasks[id] = UIApplication.shared.beginBackgroundTask(withName: "Orca notification reply") {
        self.finish(id)
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

  func responses() -> [[String: Any]] { Array(pending.values) }

  func finish(_ id: String) {
    pending.removeValue(forKey: id)
    if let task = tasks.removeValue(forKey: id), task != .invalid {
      UIApplication.shared.endBackgroundTask(task)
    }
  }
}
