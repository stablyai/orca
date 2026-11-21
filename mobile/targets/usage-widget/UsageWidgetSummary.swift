import Foundation
import WidgetKit

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
  let title: String
  let updatedAt: Double
  let session: UsageWidgetWindow?
  let weekly: UsageWidgetWindow?

  var id: String { provider }
  var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }

  /// The higher of its live windows at `date`, for picking the most used agents.
  func peakUsed(at date: Date) -> Int {
    [session, weekly].compactMap { UsageWidgetMeter($0, remaining: false, at: date).used }.max() ?? -1
  }
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
      summary.v == 2 else { return nil }
    return summary
  }
}

/// What one widget shows once its configuration is applied to the saved summary.
struct UsageWidgetContent {
  let host: UsageWidgetHost
  let providers: [UsageWidgetProvider]
  let windows: [UsageWidgetWindowKind]
  let updated: Date
}

enum UsageWidgetWindowKind {
  case session, weekly
  /// Small's default: the 5-hour window, which runs out first, else the weekly one.
  case sessionOrWeekly

  func window(of provider: UsageWidgetProvider) -> UsageWidgetWindow? {
    switch self {
    case .session: provider.session
    case .weekly: provider.weekly
    case .sessionOrWeekly: provider.session ?? provider.weekly
    }
  }

  var label: String? {
    switch self {
    case .session: String(localized: "5h")
    case .weekly: String(localized: "7d")
    case .sessionOrWeekly: nil
    }
  }
}

extension UsageWidgetSummary {
  func content(
    for configuration: UsageWidgetConfiguration, family: WidgetFamily, at date: Date
  ) -> UsageWidgetContent? {
    let chosenHost = configuration.desktop.flatMap { desktop in hosts.first { $0.id == desktop.id } }
    // Automatic, or a desktop since unpaired: the one synced most recently.
    guard let host = chosenHost ?? hosts.max(by: { ($0.updatedDate ?? .distantPast) < ($1.updatedDate ?? .distantPast) }),
      let updated = host.updatedDate else { return nil }

    let limit = family == .systemSmall ? 2 : family == .systemMedium ? 3 : 6
    let picked = (configuration.agents ?? []).compactMap { agent in host.providers.first { $0.provider == agent.id } }
    let providers: [UsageWidgetProvider]
    if !picked.isEmpty {
      providers = Array(picked.prefix(limit))
    } else if family == .systemLarge {
      providers = Array(host.providers.prefix(limit))
    } else {
      // Most used first to choose, then the app's order so the layout doesn't reshuffle.
      let top = Set(host.providers.sorted { $0.peakUsed(at: date) > $1.peakUsed(at: date) }.prefix(2).map(\.provider))
      providers = host.providers.filter { top.contains($0.provider) }
    }

    let windows: [UsageWidgetWindowKind]
    switch configuration.windows {
    case .session: windows = [.session]
    case .weekly: windows = [.weekly]
    case .both: windows = [.session, .weekly]
    case .automatic: windows = family == .systemSmall ? [.sessionOrWeekly] : [.session, .weekly]
    }
    return UsageWidgetContent(host: host, providers: providers, windows: windows, updated: updated)
  }
}
