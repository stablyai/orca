import SwiftUI
import WidgetKit

// The app only refreshes this while it is open and connected, so old numbers fade instead of passing as live.
let usageWidgetStaleAfter: TimeInterval = 60 * 60

// The widget can't reach a desktop; refreshing opens the app, which fetches and writes back.
let usageWidgetOpenURL = URL(string: "orca:///?tab=usage")!
let usageWidgetRefreshURL = URL(string: "orca:///?tab=usage&refresh=1")!

struct UsageWidgetEntry: TimelineEntry {
  let date: Date
  let summary: UsageWidgetSummary?
  let configuration: UsageWidgetConfiguration
}

struct UsageWidgetTimelineProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> UsageWidgetEntry {
    UsageWidgetEntry(date: Date(), summary: .preview, configuration: UsageWidgetConfiguration())
  }

  func snapshot(for configuration: UsageWidgetConfiguration, in context: Context) async -> UsageWidgetEntry {
    UsageWidgetEntry(date: Date(), summary: UsageWidgetSummary.load() ?? .preview, configuration: configuration)
  }

  // One entry every 5 minutes keeps "updated N min ago", reset countdowns and the stale fade current.
  func timeline(for configuration: UsageWidgetConfiguration, in context: Context) async -> Timeline<UsageWidgetEntry> {
    let summary = UsageWidgetSummary.load()
    let now = Date()
    let entries = (0..<24).map { step in
      UsageWidgetEntry(
        date: now.addingTimeInterval(TimeInterval(step) * 5 * 60), summary: summary, configuration: configuration)
    }
    return Timeline(entries: entries, policy: .atEnd)
  }
}

@main
struct OrcaUsageWidgetBundle: WidgetBundle {
  var body: some Widget {
    OrcaUsageWidget()
  }
}

struct OrcaUsageWidget: Widget {
  let kind = "OrcaUsageWidget"

  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: kind, intent: UsageWidgetConfiguration.self, provider: UsageWidgetTimelineProvider()) {
      entry in
      UsageWidgetView(entry: entry)
        .containerBackground(UsageWidgetColors.background, for: .widget)
    }
    .configurationDisplayName("Agent Usage")
    .description("Agent usage from your paired desktops, as Orca last saw it.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

extension UsageWidgetSummary {
  static let preview = UsageWidgetSummary(
    v: 2,
    display: "used",
    hosts: [
      UsageWidgetHost(
        id: "preview",
        name: "MacBook Pro",
        providers: [
          UsageWidgetProvider(
            provider: "claude", title: "Claude", updatedAt: Date().timeIntervalSince1970 * 1000,
            session: UsageWidgetWindow(usedPercent: 42, resetsAt: nil),
            weekly: UsageWidgetWindow(usedPercent: 18, resetsAt: nil)),
          UsageWidgetProvider(
            provider: "codex", title: "Codex", updatedAt: Date().timeIntervalSince1970 * 1000,
            session: UsageWidgetWindow(usedPercent: 71, resetsAt: nil),
            weekly: UsageWidgetWindow(usedPercent: 35, resetsAt: nil)),
        ])
    ])
}
