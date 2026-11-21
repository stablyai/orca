import Foundation

// Written by the app (src/home/usage-widget/usage-widget-summary.ts); keep both shapes in step.
let usageWidgetAppGroup = "group.com.stably.orca.mobile"
let usageWidgetSummaryKey = "orca.usageWidget.v1"

struct UsageWidgetWindow: Codable {
  let usedPercent: Double
  let resetsAt: Double?

  var resetDate: Date? { resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

struct UsageWidgetProvider: Codable, Identifiable {
  let provider: String
  let updatedAt: Double
  let session: UsageWidgetWindow?
  let weekly: UsageWidgetWindow?

  var id: String { provider }
  var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }
  var title: String { provider == "claude" ? "Claude" : provider == "codex" ? "Codex" : provider }
}

struct UsageWidgetHost: Codable {
  let id: String
  let name: String
  let providers: [UsageWidgetProvider]

  var updatedDate: Date? { providers.map(\.updatedDate).max() }
}

struct UsageWidgetSummary: Codable {
  let v: Int
  let display: String
  let hosts: [UsageWidgetHost]

  var showsRemaining: Bool { display == "remaining" }

  static func load() -> UsageWidgetSummary? {
    guard let raw = UserDefaults(suiteName: usageWidgetAppGroup)?.string(forKey: usageWidgetSummaryKey),
      let data = raw.data(using: .utf8),
      let summary = try? JSONDecoder().decode(UsageWidgetSummary.self, from: data),
      summary.v == 1 else { return nil }
    return summary
  }
}
