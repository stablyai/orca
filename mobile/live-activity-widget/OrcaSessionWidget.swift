import ActivityKit
import SwiftUI
import WidgetKit

@main
struct OrcaSessionWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: OrcaSessionAttributes.self) { context in
      HStack(spacing: 12) {
        Image(systemName: symbol(context)).font(.title2)
        VStack(alignment: .leading, spacing: 4) {
          Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
          Text(label(context)).font(.subheadline)
        }
        Spacer(minLength: 8)
        time(context)
      }
      .padding()
      .widgetURL(link(context))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: symbol(context))
        }
        DynamicIslandExpandedRegion(.trailing) { time(context) }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 4) {
            Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
            Text(label(context)).font(.subheadline)
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Image(systemName: symbol(context))
      } compactTrailing: {
        if context.isStale { Image(systemName: "wifi.slash") } else { time(context) }
      } minimal: {
        Image(systemName: symbol(context))
      }
      .widgetURL(link(context))
    }
  }

  private func link(_ context: ActivityViewContext<OrcaSessionAttributes>) -> URL? {
    URL(string: "orca://live-activity?id=\(context.attributes.linkId)")
  }

  private func label(_ context: ActivityViewContext<OrcaSessionAttributes>) -> String {
    let state = context.isStale ? "unavailable" : context.state.state
    return context.attributes.labels[state] ?? "Orca"
  }

  private func symbol(_ context: ActivityViewContext<OrcaSessionAttributes>) -> String {
    if context.isStale { return "wifi.slash" }
    switch context.state.state {
    case "working": return "gearshape.2"
    case "attention": return "hand.raised"
    case "done": return "checkmark.circle"
    case "failed": return "exclamationmark.circle"
    default: return "wifi.slash"
    }
  }

  @ViewBuilder
  private func time(_ context: ActivityViewContext<OrcaSessionAttributes>) -> some View {
    if context.isStale || context.state.state == "unavailable" {
      Text(Date(timeIntervalSince1970: context.state.updatedAt), style: .relative)
        .font(.caption).monospacedDigit().lineLimit(1)
    } else if context.state.state == "working" || context.state.state == "attention" {
      Text(Date(timeIntervalSince1970: context.state.stateStartedAt), style: .timer)
        .font(.caption).monospacedDigit().frame(maxWidth: 64)
    } else {
      Text(Date(timeIntervalSince1970: context.state.updatedAt), style: .time)
        .font(.caption).monospacedDigit()
    }
  }
}
