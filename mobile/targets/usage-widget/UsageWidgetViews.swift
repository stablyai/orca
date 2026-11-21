import SwiftUI
import WidgetKit

// mobile-theme.ts values, light then dark.
enum UsageWidgetColors {
  static let background = dynamic(light: 0xFFFFFF, dark: 0x171717)
  static let primary = dynamic(light: 0x0A0A0A, dark: 0xFAFAFA)
  static let secondary = dynamic(light: 0x696969, dark: 0xACACAC)
  static let track = dynamic(light: 0xF5F5F5, dark: 0x262626)
  static let green = dynamic(light: 0x147638, dark: 0x86EFAC)
  static let amber = dynamic(light: 0xCA8A04, dark: 0xEAB308)
  static let red = dynamic(light: 0xE40014, dark: 0xFF6568)

  private static func dynamic(light: UInt32, dark: UInt32) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
  }

  private static func rgb(_ hex: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }

  // The app's consumption bands: green under 60, amber under 80, red from 80.
  static func fill(used: Int) -> Color { used >= 80 ? red : used >= 60 ? amber : green }
}

/// The meter's value at `date`: nil once its window has reset, since the saved number no longer holds.
struct UsageWidgetMeter {
  let used: Int?
  let shown: Int?

  init(_ window: UsageWidgetWindow?, remaining: Bool, at date: Date) {
    guard let window, window.resetDate.map({ $0 > date }) ?? true else {
      used = nil; shown = nil; return
    }
    let rounded = Int(min(100, max(0, window.usedPercent)).rounded())
    used = rounded
    shown = remaining ? 100 - rounded : rounded
  }

  func label(remaining: Bool) -> String {
    guard let shown else { return "—" }
    return remaining ? String(localized: "\(shown)% left") : "\(shown)%"
  }
}

func usageWidgetRelative(_ date: Date, to now: Date) -> String {
  let formatter = RelativeDateTimeFormatter()
  formatter.unitsStyle = .short
  return formatter.localizedString(for: date, relativeTo: now)
}

struct UsageWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: UsageWidgetEntry

  var body: some View {
    if let summary = entry.summary,
      let content = summary.content(for: entry.configuration, family: family, at: entry.date)
    {
      let stale = entry.date.timeIntervalSince(content.updated) > usageWidgetStaleAfter
      let remaining = summary.showsRemaining
      VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
        HStack(spacing: 6) {
          Text(content.host.name).font(.caption.weight(.semibold)).lineLimit(1)
          Spacer(minLength: 4)
          if family != .systemSmall {
            updatedLabel(content.updated)
            Link(destination: usageWidgetRefreshURL) {
              Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold))
            }
            .accessibilityLabel(Text("Refresh"))
          }
        }
        .foregroundStyle(UsageWidgetColors.secondary)
        switch family {
        case .systemSmall:
          ForEach(content.providers) { provider in
            UsageWidgetSmallRow(provider: provider, windows: content.windows, remaining: remaining, date: entry.date)
          }
          Spacer(minLength: 0)
          updatedLabel(content.updated)
        case .systemLarge:
          ForEach(content.providers) { provider in
            UsageWidgetLargeRow(provider: provider, windows: content.windows, remaining: remaining, date: entry.date)
          }
          Spacer(minLength: 0)
        default:
          HStack(alignment: .top, spacing: 14) {
            ForEach(content.providers) { provider in
              UsageWidgetProviderColumn(
                provider: provider, windows: content.windows, remaining: remaining, date: entry.date)
            }
          }
          Spacer(minLength: 0)
        }
      }
      .opacity(stale ? 0.45 : 1)
      // Small widgets take one tap target, so a stale one refreshes on tap.
      .widgetURL(stale ? usageWidgetRefreshURL : usageWidgetOpenURL)
    } else {
      VStack(alignment: .leading, spacing: 6) {
        Text("Orca").font(.headline).foregroundStyle(UsageWidgetColors.primary)
        Text("Open Orca while your desktop is connected to show usage here.")
          .font(.caption).foregroundStyle(UsageWidgetColors.secondary)
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .widgetURL(usageWidgetRefreshURL)
    }
  }

  private func updatedLabel(_ updated: Date) -> some View {
    Text(usageWidgetRelative(min(updated, entry.date), to: entry.date))
      .font(.caption2).foregroundStyle(UsageWidgetColors.secondary).lineLimit(1)
  }
}

struct UsageWidgetBar: View {
  let meter: UsageWidgetMeter

  var body: some View {
    GeometryReader { proxy in
      ZStack(alignment: .leading) {
        Capsule().fill(UsageWidgetColors.track)
        if let used = meter.used, let shown = meter.shown {
          Capsule().fill(UsageWidgetColors.fill(used: used))
            .frame(width: proxy.size.width * CGFloat(shown) / 100)
        }
      }
    }
    .frame(height: 5)
  }
}

/// Small: one meter per agent, or the two windows side by side.
struct UsageWidgetSmallRow: View {
  let provider: UsageWidgetProvider
  let windows: [UsageWidgetWindowKind]
  let remaining: Bool
  let date: Date

  var body: some View {
    if let only = windows.first, windows.count == 1 {
      let meter = UsageWidgetMeter(only.window(of: provider), remaining: remaining, at: date)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          UsageWidgetAgentLabel(provider: provider, font: .caption, color: UsageWidgetColors.secondary, iconSize: 12)
          Spacer(minLength: 4)
          Text(meter.label(remaining: remaining))
            .font(.subheadline.weight(.semibold).monospacedDigit())
            .foregroundStyle(UsageWidgetColors.primary)
        }
        UsageWidgetBar(meter: meter)
      }
    } else {
      VStack(alignment: .leading, spacing: 3) {
        UsageWidgetAgentLabel(provider: provider, font: .caption, color: UsageWidgetColors.secondary, iconSize: 12)
        HStack(alignment: .top, spacing: 8) {
          ForEach(windows, id: \.self) { kind in
            UsageWidgetWindowMeter(
              kind: kind, window: kind.window(of: provider), remaining: remaining, date: date, showsReset: false)
          }
        }
      }
    }
  }
}

/// Medium: one column per agent with its windows and reset times.
struct UsageWidgetProviderColumn: View {
  let provider: UsageWidgetProvider
  let windows: [UsageWidgetWindowKind]
  let remaining: Bool
  let date: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      UsageWidgetAgentLabel(
        provider: provider, font: .subheadline.weight(.semibold), color: UsageWidgetColors.primary, iconSize: 14)
      ForEach(windows, id: \.self) { kind in
        UsageWidgetWindowMeter(kind: kind, window: kind.window(of: provider), remaining: remaining, date: date)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Large: one row per agent, its windows side by side.
struct UsageWidgetLargeRow: View {
  let provider: UsageWidgetProvider
  let windows: [UsageWidgetWindowKind]
  let remaining: Bool
  let date: Date

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      UsageWidgetAgentLabel(
        provider: provider, font: .subheadline.weight(.semibold), color: UsageWidgetColors.primary, iconSize: 14)
        .frame(width: 104, alignment: .leading)
      ForEach(windows, id: \.self) { kind in
        UsageWidgetWindowMeter(kind: kind, window: kind.window(of: provider), remaining: remaining, date: date)
      }
    }
  }
}

struct UsageWidgetWindowMeter: View {
  let kind: UsageWidgetWindowKind
  let window: UsageWidgetWindow?
  let remaining: Bool
  let date: Date
  var showsReset = true

  var body: some View {
    let meter = UsageWidgetMeter(window, remaining: remaining, at: date)
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .firstTextBaseline) {
        Text(kind.label ?? "").font(.caption2).foregroundStyle(UsageWidgetColors.secondary)
        Spacer(minLength: 2)
        Text(meter.label(remaining: remaining))
          .font(.caption.weight(.semibold).monospacedDigit())
          .foregroundStyle(UsageWidgetColors.primary)
      }
      UsageWidgetBar(meter: meter)
      if showsReset, let reset = window?.resetDate, reset > date {
        Text(usageWidgetRelative(reset, to: date))
          .font(.caption2).foregroundStyle(UsageWidgetColors.secondary).lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The agent's name with its mark, as the desktop status bar shows it; agents without a bundled mark get their initial.
struct UsageWidgetAgentLabel: View {
  let provider: UsageWidgetProvider
  let font: Font
  let color: Color
  let iconSize: CGFloat

  var body: some View {
    HStack(spacing: 4) {
      icon.frame(width: iconSize, height: iconSize)
      Text(provider.title).font(font).foregroundStyle(color).lineLimit(1)
    }
  }

  @ViewBuilder private var icon: some View {
    // Assets.xcassets follows the desktop's ProviderIcon (provider-usage-panel.tsx): Claude and Codex are the
    // AgentIcons.tsx paths, the rest copy the src/shared/agent-icons file mobile-agent-icon-assets.ts uses.
    let asset = "agent-\(provider.provider)"
    if UIImage(named: asset) != nil {
      // Codex's mark is a template image, so it takes the text color in light and dark.
      Image(asset).resizable().scaledToFit().foregroundStyle(UsageWidgetColors.primary)
        .clipShape(RoundedRectangle(cornerRadius: iconSize * 0.2))
    } else {
      Circle().fill(UsageWidgetColors.track)
        .overlay(
          Text(provider.title.prefix(1).uppercased())
            .font(.system(size: iconSize * 0.6, weight: .semibold))
            .foregroundStyle(UsageWidgetColors.secondary))
    }
  }
}
