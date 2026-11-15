import SwiftUI

@main
struct OrcaWatchApp: App {
  var body: some Scene {
    WindowGroup { PromptListView() }
  }
}

@MainActor
final class PromptStore: ObservableObject {
  @Published var prompts: [PendingPrompt] = []
  @Published var status = ""
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
}

struct PromptListView: View {
  @StateObject private var store = PromptStore()
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      List {
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
        if !store.status.isEmpty {
          Text(store.status).font(.footnote).foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Orca")
      .navigationDestination(for: PendingPrompt.self) { PromptDetailView(prompt: $0, store: store) }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await store.refresh() } }
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
  @State private var reply = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text(prompt.title).font(.headline)
        Text(prompt.detail).font(.footnote)
        Text(prompt.source).font(.caption2).foregroundStyle(.secondary)

        ForEach(prompt.options) { option in
          Button {
            send(PromptAnswer(promptId: prompt.id, decision: "option", optionId: option.id))
          } label: {
            Text(option.label).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
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
