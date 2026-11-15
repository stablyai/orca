import SwiftUI
import UserNotifications
import WatchKit

let promptCategory = "orca.prompt"

final class AppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
  func applicationDidFinishLaunching() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    // Foreground actions: only a foreground app gets cellular when the phone is away.
    let yes = UNNotificationAction(identifier: "yes", title: "Yes", options: [.foreground])
    let no = UNNotificationAction(identifier: "no", title: "No", options: [.foreground, .destructive])
    center.setNotificationCategories([
      UNNotificationCategory(identifier: promptCategory, actions: [yes, no], intentIdentifiers: [])
    ])
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
      DispatchQueue.main.async {
        guard granted else {
          PromptStore.shared.pushStatus = "Notifications off \(error?.localizedDescription ?? "")"
          return
        }
        PromptStore.shared.pushStatus = "Push: registering…"
        WKApplication.shared().registerForRemoteNotifications()
      }
    }
  }

  func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    Task { @MainActor in await PromptStore.shared.register(deviceToken: token) }
  }

  func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
    Task { @MainActor in PromptStore.shared.pushStatus = "Push failed: \(error.localizedDescription)" }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
    Task { @MainActor in await PromptStore.shared.refresh() }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    guard let promptId = info["promptId"] as? String else {
      completionHandler()
      return
    }
    let optionId: String? =
      switch response.actionIdentifier {
      case "yes": info["yesOptionId"] as? String
      case "no": info["noOptionId"] as? String
      default: nil
      }
    Task { @MainActor in
      await PromptStore.shared.handleNotification(promptId: promptId, optionId: optionId)
      completionHandler()
    }
  }
}

@main
struct OrcaWatchApp: App {
  @WKApplicationDelegateAdaptor(AppDelegate.self) var delegate

  var body: some Scene {
    WindowGroup { PromptListView() }
  }
}

@MainActor
final class PromptStore: ObservableObject {
  static let shared = PromptStore()

  @Published var prompts: [PendingPrompt] = []
  @Published var path: [PendingPrompt] = []
  @Published var status = ""
  @Published var pushStatus = ""
  @Published var loading = false

  func refresh() async {
    loading = true
    defer { loading = false }
    let started = Date()
    do {
      prompts = try await BridgeClient.shared.prompts()
      status = "Updated in \(Int(Date().timeIntervalSince(started) * 1000)) ms"
    } catch {
      status = error.localizedDescription
    }
  }

  func register(deviceToken: String) async {
    pushStatus = "Push: sending token…"
    do {
      try await BridgeClient.shared.register(deviceToken: deviceToken, environment: "development")
      pushStatus = "Push: on"
    } catch {
      pushStatus = "Push: bridge refused token: \(error.localizedDescription)"
    }
  }

  // Returns nil on success, otherwise the error to show.
  func answer(_ answer: PromptAnswer) async -> String? {
    do {
      try await BridgeClient.shared.answer(answer)
      prompts.removeAll { $0.id == answer.promptId }
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  // Yes/No from the notification answers at once; a plain tap opens the prompt.
  func handleNotification(promptId: String, optionId: String?) async {
    path = []
    if let optionId {
      status = "Sending…"
      let started = Date()
      let failure = await answer(PromptAnswer(promptId: promptId, decision: "option", optionId: optionId))
      status = failure ?? "Answered in \(Int(Date().timeIntervalSince(started) * 1000)) ms"
      await refreshKeepingStatus()
      return
    }
    await refresh()
    if let prompt = prompts.first(where: { $0.id == promptId }) {
      path = [prompt]
    } else {
      status = "That prompt is no longer waiting"
    }
  }

  private func refreshKeepingStatus() async {
    let kept = status
    await refresh()
    status = kept
  }
}

struct PromptListView: View {
  @ObservedObject private var store = PromptStore.shared
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack(path: $store.path) {
      List {
        if !store.status.isEmpty {
          Text(store.status).font(.footnote).foregroundStyle(.secondary)
        }
        if !store.pushStatus.isEmpty {
          Text(store.pushStatus).font(.footnote).foregroundStyle(.secondary)
        }
        if store.prompts.isEmpty {
          Text(store.loading ? "Loading…" : "Nothing waiting").foregroundStyle(.secondary)
        }
        ForEach(store.prompts) { prompt in
          NavigationLink(value: prompt) {
            VStack(alignment: .leading, spacing: 2) {
              Text(prompt.title).font(.headline).lineLimit(2)
              Text(prompt.source).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
          }
        }
        Button("Refresh") { Task { await store.refresh() } }
      }
      .navigationTitle("Orca")
      .navigationDestination(for: PendingPrompt.self) { PromptDetailView(prompt: $0, store: store) }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active && !store.loading { Task { await store.refresh() } }
    }
    .task { await store.refresh() }
  }
}

struct PromptDetailView: View {
  let prompt: PendingPrompt
  @ObservedObject var store: PromptStore
  @Environment(\.dismiss) private var dismiss
  @State private var sending = false
  @State private var error = ""
  @State private var confirming: PromptOption?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text(prompt.title).font(.headline)
        Text(prompt.detail).font(.footnote)
        Text(prompt.source).font(.caption2).foregroundStyle(.secondary)

        ForEach(prompt.options) { option in
          Button {
            if option.label.hasPrefix("Yes, and") {
              confirming = option
            } else {
              send(PromptAnswer(promptId: prompt.id, decision: "option", optionId: option.id))
            }
          } label: {
            Text(shortLabel(option.label)).frame(maxWidth: .infinity, alignment: .leading)
          }
          .tint(option.id == prompt.options.first?.id ? .green : option.label.hasPrefix("No") ? .red : nil)
        }
        if prompt.allowsText {
          TextFieldLink(prompt: Text("Reply")) {
            Label("Reply", systemImage: "mic")
          } onSubmit: { text in
            guard !text.isEmpty else { return }
            send(PromptAnswer(promptId: prompt.id, decision: "text", text: text))
          }
        }
        if sending { ProgressView() }
        if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(.red) }
      }
    }
    .disabled(sending)
    .confirmationDialog(
      "Also changes Claude's mode for the rest of this session.",
      isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible
    ) {
      Button(confirming.map { shortLabel($0.label) } ?? "Confirm") {
        if let option = confirming {
          send(PromptAnswer(promptId: prompt.id, decision: "option", optionId: option.id))
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(confirming?.label ?? "")
    }
  }

  // Claude's labels run to three lines; keep the decision, drop the explanation.
  private func shortLabel(_ label: String) -> String {
    if label.hasPrefix("Yes, and switch to accept edits") { return "Yes + auto-accept edits" }
    if label.hasPrefix("Yes, and don't ask again") || label.hasPrefix("Yes, and always allow") {
      return "Yes + don't ask again"
    }
    let cut = label.firstIndex(where: { $0 == "(" || $0 == ";" }) ?? label.endIndex
    return String(label[..<cut]).trimmingCharacters(in: .whitespaces)
  }

  private func send(_ answer: PromptAnswer) {
    sending = true
    error = ""
    Task {
      let failure = await store.answer(answer)
      sending = false
      if let failure {
        error = failure
      } else {
        dismiss()
      }
    }
  }
}
