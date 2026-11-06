// On-device text generation for Orca's AI text features, backed by Apple Foundation Models.
// Newline-delimited JSON on stdin/stdout so the Electron main process can drive it without a bundle.
// One request per line; the process exits on stdin EOF. Requests are sequential by design.
import Foundation
import FoundationModels

func emit(_ payload: [String: Any]) {
  guard
    let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
    let line = String(data: data, encoding: .utf8)
  else {
    return
  }
  print(line)
  fflush(stdout)
}

func stringify(_ error: Error) -> String {
  "\(error)"
}

/// Maps a generation failure to the provider failure codes the main process translates.
func failureKind(_ error: Error) -> String {
  guard let generation = error as? LanguageModelSession.GenerationError else {
    return "failed"
  }
  switch generation {
  case .exceededContextWindowSize:
    return "context"
  case .guardrailViolation, .refusal:
    return "refusal"
  case .unsupportedLanguageOrLocale:
    return "locale"
  case .rateLimited:
    return "busy"
  case .concurrentRequests:
    return "busy"
  default:
    return "failed"
  }
}

func availability() -> [String: Any] {
  switch SystemLanguageModel.default.availability {
  case .available:
    return ["available": true]
  case .unavailable(let reason):
    return ["available": false, "reason": "\(reason)"]
  }
}

func generate(id: String, instructions: String?, prompt: String) {
  let session: LanguageModelSession
  if let instructions, !instructions.isEmpty {
    session = LanguageModelSession(instructions: instructions)
  } else {
    session = LanguageModelSession()
  }

  let semaphore = DispatchSemaphore(value: 0)
  Task {
    do {
      let response = try await session.respond(to: prompt)
      emit(["id": id, "ok": true, "text": response.content])
    } catch {
      emit([
        "id": id,
        "ok": false,
        "error": failureKind(error),
        "detail": stringify(error),
      ])
    }
    semaphore.signal()
  }
  semaphore.wait()
}

func handle(line: String) {
  guard
    let data = line.data(using: .utf8),
    let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let id = request["id"] as? String
  else {
    emit(["id": "unknown", "ok": false, "error": "protocol", "detail": "unparseable request"])
    return
  }

  switch request["op"] as? String {
  case "probe":
    emit(["id": id, "ok": true].merging(availability()) { current, _ in current })
  case "generate":
    if case .unavailable(let reason) = SystemLanguageModel.default.availability {
      emit(["id": id, "ok": false, "error": "unavailable", "detail": "\(reason)"])
      return
    }
    generate(
      id: id,
      instructions: request["instructions"] as? String,
      prompt: request["prompt"] as? String ?? ""
    )
  default:
    emit(["id": id, "ok": false, "error": "protocol", "detail": "unknown op"])
  }
}

while let line = readLine(strippingNewline: true) {
  if line.isEmpty {
    continue
  }
  handle(line: line)
}
