import ActivityKit
import SwiftUI
import WidgetKit
import UIKit

@main
struct OrcaSessionWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: OrcaAgentOverviewAttributes.self) { context in
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text("Orca").font(.headline)
          Spacer()
          OverviewCounter(context: context, attention: false)
          OverviewCounter(context: context, attention: true)
        }
        OverviewSessions(context: context, detailed: true)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .widgetURL(overviewLink(context))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          OverviewCounter(context: context, attention: false, expanded: true)
            .padding(.top, 4).padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          OverviewCounter(context: context, attention: true, expanded: true)
            .padding(.top, 4).padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          OverviewSessions(context: context, maximumRows: 2)
            .padding(.horizontal, 8)
            .padding(.top, 4)
            .padding(.bottom, 8)
        }
      } compactLeading: {
        OverviewCounter(context: context, attention: false)
      } compactTrailing: {
        OverviewCounter(context: context, attention: true)
      } minimal: {
        HStack(spacing: 2) {
          Image(systemName: overviewSymbol(context.isStale ? "unavailable" : context.state.state))
          Text(context.isStale ? "?" : "\(context.state.complete ? "" : "≥")\(overviewNumber(context.state.counts.working + context.state.counts.attention + context.state.counts.failed))").monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
        }
          .font(.caption2)
          .accessibilityLabel(overviewSummary(context))
      }
      .contentMargins(.bottom, 12, for: .expanded)
      .contentMargins(.trailing, 8, for: .compactTrailing)
      .widgetURL(overviewLink(context))
    }
  }
}

private func overviewLink(_ context: ActivityViewContext<OrcaAgentOverviewAttributes>) -> URL? {
  URL(string: "orca://live-activity?id=\(context.attributes.linkId)")
}

private func overviewLabel(_ context: ActivityViewContext<OrcaAgentOverviewAttributes>, _ key: String) -> String {
  context.attributes.labels[key] ?? key
}

private func overviewSummary(_ context: ActivityViewContext<OrcaAgentOverviewAttributes>) -> String {
  if context.isStale { return overviewLabel(context, "unavailable") }
  return "\(context.state.counts.working) \(overviewLabel(context, "working")), \(context.state.counts.attention) \(overviewLabel(context, "attention")), \(context.state.counts.failed) \(overviewLabel(context, "failed"))" + (context.state.complete ? "" : ", " + overviewLabel(context, "partial"))
}

private func overviewSymbol(_ state: String) -> String {
  switch state {
  case "working": return "gearshape"
  case "attention": return "hand.raised"
  case "done": return "checkmark.circle"
  case "failed": return "exclamationmark.circle"
  default: return "wifi.slash"
  }
}

private func overviewNumber(_ count: Int) -> String {
  count >= 1000 ? count.formatted(.number.notation(.compactName)) : String(count)
}

private struct OverviewCounter: View {
  let context: ActivityViewContext<OrcaAgentOverviewAttributes>
  var attention: Bool
  var expanded = false
  @ScaledMetric(relativeTo: .headline) private var symbolSize = 16

  var body: some View {
    let count = attention ? context.state.counts.attention + context.state.counts.failed : context.state.counts.working
    return HStack(spacing: 4) {
      Image(systemName: attention ? "hand.raised" : "gearshape")
        .resizable().scaledToFit()
        .frame(width: symbolSize, height: symbolSize)
        .padding(2).accessibilityHidden(true)
      Text(context.isStale ? "?" : "\(context.state.complete ? "" : "≥")\(overviewNumber(count))")
        .monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
    }
    .font(expanded ? .headline : .subheadline)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(context.isStale ? overviewLabel(context, "unavailable") : "\(count) \(overviewLabel(context, attention ? "attention" : "working"))" + (context.state.complete ? "" : ", " + overviewLabel(context, "partial")))
  }
}

private struct OverviewSessions: View {
  let context: ActivityViewContext<OrcaAgentOverviewAttributes>
  var maximumRows = 3
  var detailed = false
  @Environment(\.dynamicTypeSize) private var typeSize

  private var limit: Int { min(maximumRows, typeSize.isAccessibilitySize ? 1 : typeSize > .large ? 2 : 3) }
  private var otherSessions: Int {
    let counts = context.state.counts
    return max(0, counts.working + counts.attention + counts.done + counts.failed + counts.unavailable - min(limit, context.state.sessions.count))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: detailed ? 2 : 4) {
      if context.isStale {
        Text(overviewLabel(context, "unavailable")).font(.subheadline)
      } else {
        ForEach(Array(context.state.sessions.prefix(limit).enumerated()), id: \.element.renderId) { index, session in
          if let url = URL(string: "orca://live-activity?id=\(context.attributes.linkId)&scope=\(session.scopeId)&session=\(session.id)") {
            Link(destination: url) {
              HStack(spacing: 8) {
                OverviewAgentIcon(agent: session.agent)
                  .frame(width: 20, height: 20)
                  .accessibilityLabel(session.agent ?? "")
                  .accessibilityHidden(session.agent == nil)
                VStack(alignment: .leading, spacing: 0) {
                  Text(session.title.isEmpty ? "\(overviewLabel(context, "session")) \(index + 1)" : session.title)
                    .lineLimit(1).privacySensitive()
                  if detailed {
                    Text(overviewLabel(context, session.state))
                      .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                  }
                }
                Spacer(minLength: 4)
                if !detailed {
                  Image(systemName: overviewSymbol(session.state))
                    .font(.caption2).accessibilityLabel(overviewLabel(context, session.state))
                }
                if session.state == "working" || session.state == "attention" {
                  Text(Date(timeIntervalSince1970: session.stateStartedAt), style: .timer)
                    .font(.subheadline).monospacedDigit()
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .frame(width: 64, alignment: .trailing).multilineTextAlignment(.trailing)
                } else {
                  Image(systemName: overviewSymbol(session.state)).accessibilityHidden(true)
                }
              }
              .font(.subheadline)
              .contentShape(Rectangle())
            }
          }
        }
        if context.state.sessions.isEmpty {
          Text(overviewLabel(context, context.state.state)).font(.subheadline)
        }
      }
      HStack(spacing: 4) {
        Text(overviewLabel(context, context.state.complete && !context.isStale ? "allHosts" : "partial"))
        if context.state.complete || context.state.knownSources < context.state.totalSources {
          Text("\(context.isStale ? 0 : context.state.knownSources)/\(context.state.totalSources)")
        }
        Spacer(minLength: 4)
        if otherSessions > 0 && !context.isStale {
          Text("+\(otherSessions) \(overviewLabel(context, "more"))")
        }
        if context.state.counts.done > 0 && !context.isStale {
          Image(systemName: "checkmark.circle").accessibilityHidden(true)
          Text("\(context.state.counts.done)").monospacedDigit()
            .accessibilityLabel("\(context.state.counts.done) \(overviewLabel(context, "done"))")
        }
      }
      .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
      .fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct OverviewAgentIcon: View {
  var agent: String?

  private var asset: String? {
    switch agent {
    case "claude-agent-teams": return "claude"
    case "opencode2": return "opencode"
    case "dsb": return "dsh"
    default: return agent
    }
  }

  var body: some View {
    if let asset, let image = UIImage(named: "live-agent-" + asset) {
      Image(uiImage: image)
        .renderingMode(["codex", "pi", "aider"].contains(asset) ? .template : .original)
        .resizable().scaledToFit()
    } else {
      Image(systemName: "terminal").resizable().scaledToFit()
    }
  }
}
