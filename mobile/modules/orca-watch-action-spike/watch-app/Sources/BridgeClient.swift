import Foundation

struct PromptOption: Codable, Hashable, Identifiable {
  let id: String
  let label: String
}

struct PendingPrompt: Codable, Hashable, Identifiable {
  let id: String
  let kind: String  // "approval" | "question"
  let title: String
  let detail: String
  let source: String
  let options: [PromptOption]
  let allowsText: Bool
  let createdAt: Double
}

struct PromptAnswer: Encodable {
  let promptId: String
  let decision: String  // "approve" | "deny" | "option" | "text"
  var optionId: String?
  var text: String?
}

enum BridgeError: LocalizedError {
  case notConfigured
  case http(Int, String)

  var errorDescription: String? {
    switch self {
    case .notConfigured: return "Bridge URL or token missing from this build"
    case .http(let status, let message): return message.isEmpty ? "HTTP \(status)" : message
    }
  }
}

// HTTPS only: watchOS blocks WebSockets for apps like this, and only foreground requests get cellular.
final class BridgeClient {
  static let shared = BridgeClient()

  private let baseURL: URL?
  private let token: String
  private let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = true
    configuration.timeoutIntervalForResource = 20
    return URLSession(configuration: configuration)
  }()

  private init() {
    let info = Bundle.main.infoDictionary ?? [:]
    let url = (info["OrcaBridgeURL"] as? String) ?? ""
    baseURL = url.hasPrefix("https://") ? URL(string: url) : nil
    token = (info["OrcaBridgeToken"] as? String) ?? ""
  }

  func prompts() async throws -> [PendingPrompt] {
    struct Body: Decodable { let prompts: [PendingPrompt] }
    let data = try await send(path: "watch/v1/prompts", method: "GET", body: nil)
    return try JSONDecoder().decode(Body.self, from: data).prompts
  }

  func register(deviceToken: String, environment: String) async throws {
    let body = try JSONEncoder().encode(["deviceToken": deviceToken, "environment": environment])
    _ = try await send(path: "watch/v1/register", method: "POST", body: body)
  }

  func answer(_ answer: PromptAnswer) async throws {
    _ = try await send(path: "watch/v1/answer", method: "POST", body: try JSONEncoder().encode(answer))
  }

  private func send(path: String, method: String, body: Data?) async throws -> Data {
    guard let baseURL, !token.isEmpty else { throw BridgeError.notConfigured }
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      struct ErrorBody: Decodable { let error: String }
      let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? ""
      throw BridgeError.http(status, message)
    }
    return data
  }
}
