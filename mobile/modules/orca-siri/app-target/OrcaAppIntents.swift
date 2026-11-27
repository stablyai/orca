// Copied into the app target by plugins/ios-siri-app-intents.js: Xcode extracts App Intents
// metadata only from the app target, not from static CocoaPods libraries. All logic lives in the
// OrcaSiri pod; this file only declares what Siri can do.
import AppIntents
// `internal` to match ExpoModulesProvider.swift, which Expo autolinking generates with internal imports.
internal import OrcaSiri

// MARK: - Agent entity

@available(iOS 26.0, *)
struct OrcaAgentEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Orca agent")
  static let defaultQuery = OrcaAgentQuery()

  let id: String
  let name: String
  let detail: String

  init(_ agent: SiriAgent) {
    id = agent.id
    name = agent.name
    detail = [agent.state, agent.workspace].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: "\(detail)")
  }
}

@available(iOS 26.0, *)
struct OrcaAgentQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [OrcaAgentEntity] {
    try await SiriBridgeClient.shared.overview().agents
      .filter { identifiers.contains($0.id) }
      .map(OrcaAgentEntity.init)
  }

  func entities(matching string: String) async throws -> [OrcaAgentEntity] {
    let needle = string.lowercased()
    return try await SiriBridgeClient.shared.overview().agents
      .filter {
        $0.name.lowercased().contains(needle) || $0.workspace.lowercased().contains(needle)
          || $0.agentType.lowercased() == needle
      }
      .map(OrcaAgentEntity.init)
  }

  func suggestedEntities() async throws -> [OrcaAgentEntity] {
    try await SiriBridgeClient.shared.overview().agents.map(OrcaAgentEntity.init)
  }
}

// MARK: - Check Orca: what's waiting, then approve / deny / reply by voice

@available(iOS 26.0, *)
struct CheckOrcaIntent: AppIntent {
  static let title: LocalizedStringResource = "Check Orca"
  static let description = IntentDescription(
    "Hear what your Orca agents need and approve, deny or answer by voice.")
  // Approving while the phone is locked is a deliberate choice: in CarPlay it always is.
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  @Parameter(title: "Reply", requestValueDialog: "What should I tell Claude?")
  var reply: String?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let overview = try await SiriBridgeClient.shared.overview()
    guard let prompt = overview.prompts.first else {
      return .result(dialog: "\(SiriSpeech.overview(overview))")
    }

    let approve = IntentChoiceOption(title: "Approve")
    let deny = IntentChoiceOption(title: "Deny", style: .destructive)
    let answer = IntentChoiceOption(title: "Reply")
    var choices = [IntentChoiceOption]()
    if SiriSpeech.approveOption(prompt) != nil { choices.append(approve) }
    if SiriSpeech.denyOption(prompt) != nil { choices.append(deny) }
    if prompt.allowsText { choices.append(answer) }
    choices.append(.cancel)

    let choice = try await requestChoice(
      between: choices, dialog: "\(SiriSpeech.waitingIntro(overview.prompts)) What should I do?")

    switch choice {
    case approve:
      guard let option = SiriSpeech.approveOption(prompt) else { break }
      try await SiriBridgeClient.shared.answer(promptId: prompt.id, optionId: option.id)
      return .result(dialog: "Approved.")
    case deny:
      guard let option = SiriSpeech.denyOption(prompt) else { break }
      try await SiriBridgeClient.shared.answer(promptId: prompt.id, optionId: option.id)
      return .result(dialog: "Denied.")
    case answer:
      let text = try await $reply.requestValue("What should I tell Claude?")
      try await SiriBridgeClient.shared.answer(promptId: prompt.id, text: text)
      return .result(dialog: "Sent your reply.")
    default:
      break
    }
    return .result(dialog: "Okay, I left it waiting.")
  }
}

// MARK: - Approve in Orca: one-shot approval after a notification

@available(iOS 26.0, *)
struct ApproveOrcaPromptIntent: AppIntent {
  static let title: LocalizedStringResource = "Approve Orca Prompt"
  static let description = IntentDescription(
    "Approve the newest waiting Orca prompt with a plain Yes. Never turns on auto-accept.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let prompts = try await SiriBridgeClient.shared.overview().prompts
    // A prompt with no plain Yes (a text question) mustn't hide a later one that can be approved.
    guard let prompt = prompts.first(where: { SiriSpeech.approveOption($0) != nil }),
      let option = SiriSpeech.approveOption(prompt)
    else {
      return .result(dialog: "Nothing is waiting for approval.")
    }
    // Say what will run before it runs; "no" cancels.
    try await requestConfirmation(
      actionName: .go, dialog: "\(SiriSpeech.describe(prompt)) Approve it?")
    try await SiriBridgeClient.shared.answer(promptId: prompt.id, optionId: option.id)
    let rest = prompts.count - 1
    return .result(
      dialog: rest > 0 ? "Approved. \(rest) more waiting." : "Approved.")
  }
}

// MARK: - Agent status

@available(iOS 26.0, *)
struct OrcaAgentStatusIntent: AppIntent {
  static let title: LocalizedStringResource = "Orca Agent Status"
  static let description = IntentDescription("Hear what an Orca agent is doing or last said.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  @Parameter(title: "Agent")
  var agent: OrcaAgentEntity?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let overview = try await SiriBridgeClient.shared.overview()
    if let agent, let match = overview.agents.first(where: { $0.id == agent.id }) {
      return .result(dialog: "\(SiriSpeech.status(of: match))")
    }
    if overview.agents.isEmpty {
      return .result(dialog: "No agents are running.")
    }
    // The newest three keep the answer under about 20 seconds of speech.
    let lines = overview.agents.prefix(3).map(SiriSpeech.status(of:))
    let more = overview.agents.count > 3 ? " And \(overview.agents.count - 3) more." : ""
    return .result(dialog: "\(lines.joined(separator: " "))\(more)")
  }
}

// MARK: - Message an agent

@available(iOS 26.0, *)
struct MessageOrcaAgentIntent: AppIntent {
  static let title: LocalizedStringResource = "Message Orca Agent"
  static let description = IntentDescription(
    "Send a message to an Orca agent that's done or waiting, like \"continue\".")
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  @Parameter(title: "Agent")
  var agent: OrcaAgentEntity?

  @Parameter(title: "Message", requestValueDialog: "What should I tell it?")
  var message: String?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let target = try await resolveAgent()
    let text: String
    if let message, !message.isEmpty {
      text = message
    } else {
      text = try await $message.requestValue("What should I tell \(target.name)?")
    }
    let result = try await SiriBridgeClient.shared.message(agentId: target.id, text: text)
    return .result(dialog: "\(SiriSpeech.sent(result, to: target.name))")
  }

  // A spoken agent wins; otherwise the only idle one; otherwise Siri asks which.
  private func resolveAgent() async throws -> OrcaAgentEntity {
    if let agent { return agent }
    let idle = try await SiriBridgeClient.shared.overview().agents
      .filter { $0.state != "working" }
      .map(OrcaAgentEntity.init)
    if idle.count == 1 { return idle[0] }
    if idle.isEmpty {
      throw SiriBridgeError.http(409, "Every agent is busy right now.")
    }
    return try await $agent.requestDisambiguation(among: idle, dialog: "Which agent?")
  }
}

// MARK: - Phrases that work with no setup

@available(iOS 26.0, *)
struct OrcaAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: CheckOrcaIntent(),
      phrases: [
        "Check \(.applicationName)",
        "What's waiting in \(.applicationName)",
        "What does \(.applicationName) need",
      ],
      shortTitle: "Check Orca",
      systemImageName: "bell.badge")
    AppShortcut(
      intent: ApproveOrcaPromptIntent(),
      phrases: [
        "Approve in \(.applicationName)",
        "Approve \(.applicationName) prompt",
      ],
      shortTitle: "Approve",
      systemImageName: "checkmark.circle")
    AppShortcut(
      intent: OrcaAgentStatusIntent(),
      phrases: [
        "What's \(.applicationName) doing",
        "\(.applicationName) status",
        "What is \(\.$agent) doing in \(.applicationName)",
      ],
      shortTitle: "Agent Status",
      systemImageName: "waveform")
    AppShortcut(
      intent: MessageOrcaAgentIntent(),
      phrases: [
        "Tell \(.applicationName)",
        "Message \(.applicationName)",
        "Message \(\.$agent) in \(.applicationName)",
      ],
      shortTitle: "Message Agent",
      systemImageName: "text.bubble")
  }
}
