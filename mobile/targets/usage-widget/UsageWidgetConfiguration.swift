import AppIntents
import WidgetKit

/// Which usage windows a meter shows; automatic keeps each size's original layout.
enum UsageWidgetWindowChoice: String, AppEnum {
  case automatic, session, weekly, both

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Usage Window"
  static let caseDisplayRepresentations: [UsageWidgetWindowChoice: DisplayRepresentation] = [
    .automatic: "Automatic",
    .session: "5 hours",
    .weekly: "Weekly",
    .both: "5 hours and weekly",
  ]
}

struct UsageDesktopEntity: AppEntity {
  static let automaticID = "automatic"
  static let automatic = UsageDesktopEntity(id: automaticID, name: String(localized: "Most recently updated"))
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Desktop"
  static let defaultQuery = UsageDesktopQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

/// Lists the desktops the app last wrote to the App Group; the widget can't reach the pairing list itself.
struct UsageDesktopQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [UsageDesktopEntity] {
    let all = allDesktops()
    return identifiers.compactMap { id in all.first { $0.id == id } }
  }

  func suggestedEntities() async throws -> [UsageDesktopEntity] { allDesktops() }

  func defaultResult() async -> UsageDesktopEntity? { .automatic }

  private func allDesktops() -> [UsageDesktopEntity] {
    let hosts = UsageWidgetSummary.load()?.hosts ?? []
    return [.automatic] + hosts.map { UsageDesktopEntity(id: $0.id, name: $0.name) }
  }
}

struct UsageAgentEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
  static let defaultQuery = UsageAgentQuery()

  let id: String
  let title: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
}

/// Every agent any saved desktop reports, so a pick survives switching desktops.
struct UsageAgentQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [UsageAgentEntity] {
    let all = allAgents()
    // Keep a pick whose agent is missing from the latest sync instead of silently dropping it.
    return identifiers.map { id in all.first { $0.id == id } ?? UsageAgentEntity(id: id, title: id) }
  }

  func suggestedEntities() async throws -> [UsageAgentEntity] { allAgents() }

  private func allAgents() -> [UsageAgentEntity] {
    var seen = Set<String>()
    return (UsageWidgetSummary.load()?.hosts ?? []).flatMap(\.providers).compactMap { provider in
      seen.insert(provider.provider).inserted ? UsageAgentEntity(id: provider.provider, title: provider.title) : nil
    }
  }
}

struct UsageWidgetConfiguration: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Agent Usage"
  static let description = IntentDescription("Choose the desktop, agents and usage windows to show.")

  @Parameter(title: "Desktop")
  var desktop: UsageDesktopEntity?

  @Parameter(
    title: "Agents", description: "Leave empty to show the most used.",
    size: [.systemSmall: 2, .systemMedium: 3, .systemLarge: 6])
  var agents: [UsageAgentEntity]?

  @Parameter(title: "Usage Window", default: .automatic)
  var windows: UsageWidgetWindowChoice
}
