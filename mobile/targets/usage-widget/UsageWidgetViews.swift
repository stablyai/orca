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
    if let summary = entry.summary, let host = summary.hosts.first, let updated = host.updatedDate {
      let stale = entry.date.timeIntervalSince(updated) > usageWidgetStaleAfter
      VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
        HStack(spacing: 6) {
          Text(host.name).font(.caption.weight(.semibold)).lineLimit(1)
          Spacer(minLength: 4)
          if family != .systemSmall {
            updatedLabel(updated)
            Link(destination: usageWidgetRefreshURL) {
              Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold))
            }
            .accessibilityLabel(Text("Refresh"))
          }
        }
        .foregroundStyle(UsageWidgetColors.secondary)
        if family == .systemSmall {
          ForEach(host.providers.prefix(2)) { provider in
            UsageWidgetSmallRow(provider: provider, remaining: summary.showsRemaining, date: entry.date)
          }
          Spacer(minLength: 0)
          updatedLabel(updated)
        } else {
          HStack(alignment: .top, spacing: 14) {
            ForEach(host.providers.prefix(2)) { provider in
              UsageWidgetProviderColumn(provider: provider, remaining: summary.showsRemaining, date: entry.date)
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

/// Small: the 5-hour window, which runs out first.
struct UsageWidgetSmallRow: View {
  let provider: UsageWidgetProvider
  let remaining: Bool
  let date: Date

  var body: some View {
    let meter = UsageWidgetMeter(provider.session ?? provider.weekly, remaining: remaining, at: date)
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline) {
        Text(provider.title).font(.caption).foregroundStyle(UsageWidgetColors.secondary)
        Spacer(minLength: 4)
        Text(meter.label(remaining: remaining))
          .font(.subheadline.weight(.semibold).monospacedDigit())
          .foregroundStyle(UsageWidgetColors.primary)
      }
      UsageWidgetBar(meter: meter)
    }
  }
}

/// Medium: both windows with their reset times.
struct UsageWidgetProviderColumn: View {
  let provider: UsageWidgetProvider
  let remaining: Bool
  let date: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(provider.title).font(.subheadline.weight(.semibold))
        .foregroundStyle(UsageWidgetColors.primary)
      windowRow(String(localized: "5h"), provider.session)
      windowRow(String(localized: "7d"), provider.weekly)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func windowRow(_ label: String, _ window: UsageWidgetWindow?) -> some View {
    let meter = UsageWidgetMeter(window, remaining: remaining, at: date)
    return VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .firstTextBaseline) {
        Text(label).font(.caption2).foregroundStyle(UsageWidgetColors.secondary)
        Spacer(minLength: 2)
        Text(meter.label(remaining: remaining))
          .font(.caption.weight(.semibold).monospacedDigit())
          .foregroundStyle(UsageWidgetColors.primary)
      }
      UsageWidgetBar(meter: meter)
      if let reset = window?.resetDate, reset > date {
        Text(usageWidgetRelative(reset, to: date))
          .font(.caption2).foregroundStyle(UsageWidgetColors.secondary).lineLimit(1)
      }
    }
  }
}
