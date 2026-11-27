import ExpoModulesCore

/// JS side of the Siri setup: saves the bridge URL and token where the intents can read them.
public class OrcaSiriModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaSiri")

    AsyncFunction("getConfiguration") { () -> [String: Any] in
      guard let configuration = SiriBridgeKeychain.load() else { return ["configured": false] }
      return ["configured": true, "url": configuration.url.absoluteString]
    }

    AsyncFunction("configure") { (url: String, token: String) in
      let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
      guard trimmed.hasPrefix("https://"), let parsed = URL(string: trimmed) else {
        throw Exception(name: "BadURL", description: "The bridge URL must start with https://")
      }
      let secret = token.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !secret.isEmpty else {
        throw Exception(name: "BadToken", description: "Paste the Siri token from your Mac")
      }
      try SiriBridgeKeychain.save(SiriBridgeConfiguration(url: parsed, token: secret))
    }

    AsyncFunction("clearConfiguration") {
      SiriBridgeKeychain.clear()
    }

    // Uses the same request as "Check Orca", so a pass here means Siri will work too.
    AsyncFunction("testConnection") { () async -> [String: Any] in
      let started = Date()
      do {
        let overview = try await SiriBridgeClient.shared.overview()
        return [
          "ok": true,
          "ms": Int(Date().timeIntervalSince(started) * 1000),
          "prompts": overview.prompts.count,
          "agents": overview.agents.count,
          "speech": SiriSpeech.overview(overview),
        ]
      } catch {
        return [
          "ok": false,
          "ms": Int(Date().timeIntervalSince(started) * 1000),
          "error": error.localizedDescription,
        ]
      }
    }
  }
}
