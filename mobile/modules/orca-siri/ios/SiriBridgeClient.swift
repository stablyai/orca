import Foundation

public enum SiriBridgeError: LocalizedError {
  case notConfigured
  case http(Int, String)
  case unreachable(String)

  public var errorDescription: String? {
    switch self {
    case .notConfigured:
      return "Siri isn't set up yet. Open Orca, go to Settings, Troubleshoot, and add your bridge."
    case .http(let status, let message):
      return message.isEmpty ? "Your Mac answered with error \(status)." : message
    case .unreachable(let reason):
      return "I couldn't reach your Mac. \(reason)"
    }
  }
}

/// HTTPS to the Mac bridge. An App Intent runs in native code with no React Native, so this
/// doesn't use the app's paired connection: that tries direct routes for up to 20s before the
/// relay, which is longer than Siri waits.
public final class SiriBridgeClient: @unchecked Sendable {
  public static let shared = SiriBridgeClient()

  private let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    // Siri gives up after about 10s; fail with a sentence it can speak instead.
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = 8
    configuration.timeoutIntervalForResource = 9
    return URLSession(configuration: configuration)
  }()

  public func overview() async throws -> SiriOverview {
    let data = try await send(path: "siri/v1/overview", method: "GET", body: nil)
    return try JSONDecoder().decode(SiriOverview.self, from: data)
  }

  @discardableResult
  public func answer(promptId: String, optionId: String) async throws -> SiriWriteResult {
    try await write(
      path: "siri/v1/answer",
      body: ["promptId": promptId, "decision": "option", "optionId": optionId])
  }

  @discardableResult
  public func answer(promptId: String, text: String) async throws -> SiriWriteResult {
    try await write(
      path: "siri/v1/answer", body: ["promptId": promptId, "decision": "text", "text": text])
  }

  @discardableResult
  public func message(agentId: String, text: String) async throws -> SiriWriteResult {
    try await write(path: "siri/v1/message", body: ["agentId": agentId, "text": text])
  }

  private func write(path: String, body: [String: String]) async throws -> SiriWriteResult {
    let data = try await send(path: path, method: "POST", body: try JSONEncoder().encode(body))
    return try JSONDecoder().decode(SiriWriteResult.self, from: data)
  }

  private func send(path: String, method: String, body: Data?) async throws -> Data {
    guard let configuration = SiriBridgeKeychain.load() else { throw SiriBridgeError.notConfigured }
    var request = URLRequest(url: configuration.url.appendingPathComponent(path))
    request.httpMethod = method
    request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw SiriBridgeError.unreachable(error.localizedDescription)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      struct ErrorBody: Decodable { let error: String }
      let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? ""
      throw SiriBridgeError.http(status, message)
    }
    return data
  }
}
