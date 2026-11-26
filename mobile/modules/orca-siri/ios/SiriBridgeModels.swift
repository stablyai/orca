import Foundation

// Wire types for the bridge's /siri/v1 endpoints (watch-bridge.mjs). Public so the App Intents in the
// app target can use them.

public struct SiriPromptOption: Codable, Hashable, Sendable {
  public let id: String
  public let label: String
}

public struct SiriPrompt: Codable, Hashable, Sendable {
  public let id: String
  public let kind: String
  public let title: String
  public let detail: String
  public let source: String
  public let options: [SiriPromptOption]
  public let allowsText: Bool
  public let createdAt: Double?
}

public struct SiriAgent: Codable, Hashable, Sendable {
  public let id: String
  public let name: String
  public let workspace: String
  public let agentType: String
  public let state: String  // working | blocked | waiting | done
  public let stateStartedAt: Double?
  public let needsApproval: Bool
  public let task: String
  public let lastMessage: String
}

public struct SiriOverview: Codable, Sendable {
  public let prompts: [SiriPrompt]
  public let agents: [SiriAgent]
}

public struct SiriWriteResult: Decodable, Sendable {
  public let ok: Bool?
  public let confirmed: Bool?
  public let name: String?
}
