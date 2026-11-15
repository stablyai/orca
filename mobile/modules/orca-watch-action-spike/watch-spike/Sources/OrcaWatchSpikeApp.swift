import SwiftUI
import UserNotifications
import WatchKit

final class SpikeAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
  func applicationDidFinishLaunching() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let yes = UNNotificationAction(identifier: "yes", title: "Yes")
    let yesOpen = UNNotificationAction(identifier: "yes-open", title: "Yes (open app)", options: [.foreground])
    let no = UNNotificationAction(identifier: "no", title: "No", options: [.destructive])
    let reply = UNTextInputNotificationAction(
      identifier: "reply", title: "Reply", textInputButtonTitle: "Send", textInputPlaceholder: "Reply")
    center.setNotificationCategories([
      UNNotificationCategory(identifier: spikeCategory, actions: [yes, no, reply, yesOpen], intentIdentifiers: [])
    ])
    SpikeLog.add("launch state=\(stateName())")
  }

  func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
    for task in backgroundTasks {
      if let sessionTask = task as? WKURLSessionRefreshBackgroundTask {
        SpikeLog.add("bg-session wake \(sessionTask.sessionIdentifier)")
        _ = SpikeProbe.shared.background
        SpikeProbe.shared.pendingRefreshTasks.append(sessionTask)
      } else {
        task.setTaskCompletedWithSnapshot(false)
      }
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let tapAt = Date()
    guard response.notification.request.content.categoryIdentifier == spikeCategory else {
      completionHandler()
      return
    }
    let action = response.actionIdentifier.replacingOccurrences(
      of: UNNotificationDefaultActionIdentifier, with: "open")
    let sinceDelivered = millis(since: response.notification.date)
    let reply = (response as? UNTextInputNotificationResponse).map { " reply=\"\($0.userText)\"" } ?? ""
    SpikeLog.add("tap \(action) state=\(stateName()) deliveredAgo=\(sinceDelivered)ms\(reply)")
    SpikeProbe.shared.runForTap(label: action, tapAt: tapAt, done: completionHandler)
  }

  private func stateName() -> String {
    switch WKApplication.shared().applicationState {
    case .active: return "active"
    case .inactive: return "inactive"
    case .background: return "background"
    @unknown default: return "unknown"
    }
  }
}

@main
struct OrcaWatchSpikeApp: App {
  @WKApplicationDelegateAdaptor(SpikeAppDelegate.self) var delegate

  var body: some Scene {
    WindowGroup { ContentView() }
  }
}

struct ContentView: View {
  @State private var lines: [String] = []
  @State private var lastAlive = "-"
  @State private var status = ""

  var body: some View {
    List {
      Button("Arm 15s") { arm(15) }
      Button("Arm 60s") { arm(60) }
      Button("Ping now") {
        SpikeProbe.shared.runForTap(label: "ping", tapAt: Date()) {}
        status = "Pinging; tap Refresh in a few seconds"
      }
      Button("Refresh") { refresh() }
      Button("Clear", role: .destructive) {
        SpikeLog.clear()
        refresh()
      }
      if !status.isEmpty { Text(status).font(.footnote) }
      Text("Last alive: \(lastAlive)").font(.footnote)
      ForEach(lines.reversed(), id: \.self) { Text($0).font(.system(size: 11)) }
    }
    .onAppear(perform: refresh)
  }

  private func refresh() {
    lines = SpikeLog.all()
    lastAlive = SpikeLog.lastAlive()
  }

  private func arm(_ seconds: Double) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
      guard granted else {
        DispatchQueue.main.async { status = "Notifications not allowed" }
        return
      }
      let content = UNMutableNotificationContent()
      content.title = "Orca watch test"
      content.body = "Claude wants to run: echo hello. Allow?"
      content.categoryIdentifier = spikeCategory
      content.sound = .default
      let trigger = UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)
      center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger))
      SpikeLog.add("armed \(Int(seconds))s")
      DispatchQueue.main.async { status = "Armed: lower your wrist; it arrives in \(Int(seconds))s" }
    }
  }
}
