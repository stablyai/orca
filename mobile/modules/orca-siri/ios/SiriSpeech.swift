import Foundation

/// The sentences Siri speaks. Kept short and free of markup: in CarPlay they're heard, not read.
public enum SiriSpeech {
  /// Exactly "Yes". Any longer "Yes, …" option can change Claude's mode for the whole session (the
  /// Watch app guards those behind a second tap; the bridge refuses them from the Siri token).
  public static func approveOption(_ prompt: SiriPrompt) -> SiriPromptOption? {
    prompt.options.first {
      $0.label.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare("yes") == .orderedSame
    }
  }

  public static func denyOption(_ prompt: SiriPrompt) -> SiriPromptOption? {
    prompt.options.first { $0.label.lowercased().hasPrefix("no") }
  }

  /// "Fix login bug in api wants to use Bash: npm test."
  public static func describe(_ prompt: SiriPrompt) -> String {
    // The bridge joins agent and workspace with " · ", which Siri can't say.
    let who = prompt.source.isEmpty ? "Claude" : prompt.source.replacingOccurrences(of: " · ", with: " in ")
    let tool = prompt.detail.split(separator: "\n").first.map(String.init) ?? ""
    let action = tool.isEmpty ? prompt.title : "wants to use \(clip(tool, 140))."
    return "\(who) \(action)"
  }

  public static func waitingIntro(_ prompts: [SiriPrompt]) -> String {
    guard let first = prompts.first else { return "" }
    let lead = prompts.count > 1 ? "\(prompts.count) prompts are waiting. First: " : ""
    return "\(lead)\(describe(first))"
  }

  /// "Nothing is waiting. 2 agents are working and 1 is done."
  public static func overview(_ overview: SiriOverview) -> String {
    let waiting = overview.prompts.count
    let head =
      waiting == 0
      ? "Nothing is waiting."
      : "\(waiting) \(waiting == 1 ? "prompt is" : "prompts are") waiting for you."
    let counts = ["working", "waiting", "blocked", "done"].compactMap { state -> String? in
      let count = overview.agents.filter { $0.state == state }.count
      guard count > 0 else { return nil }
      return "\(count) \(state)"
    }
    guard !counts.isEmpty else { return "\(head) No agents are running." }
    let total = overview.agents.count
    return "\(head) \(total) \(total == 1 ? "agent" : "agents"): \(counts.joined(separator: ", "))."
  }

  /// "Fix login bug is working on: add rate limiting." / "Codex in api is done. It said: …"
  public static func status(of agent: SiriAgent) -> String {
    switch agent.state {
    case "working":
      return agent.task.isEmpty
        ? "\(agent.name) is working." : "\(agent.name) is working on: \(clip(agent.task, 120))"
    case "waiting", "blocked":
      if agent.needsApproval { return "\(agent.name) is waiting for your approval." }
      return agent.lastMessage.isEmpty
        ? "\(agent.name) is waiting for you." : "\(agent.name) asks: \(agent.lastMessage)"
    default:
      return agent.lastMessage.isEmpty
        ? "\(agent.name) is done." : "\(agent.name) is done. It said: \(agent.lastMessage)"
    }
  }

  public static func sent(_ result: SiriWriteResult, to name: String) -> String {
    result.confirmed == true ? "Sent. \(name) is on it." : "Sent to \(name)."
  }

  static func clip(_ text: String, _ max: Int) -> String {
    text.count <= max ? text : String(text.prefix(max)) + "…"
  }
}
