import Foundation

struct MobileWebActivationRecord: Codable, Equatable {
  let active: String
  let previous: String?
}

func parseMobileWebActivationRecord(_ data: Data) -> MobileWebActivationRecord? {
  guard
    let json = String(data: data, encoding: .utf8),
    isExactMobileWebJsonDocument(json),
    let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(value.keys) == Set(["active"]) || Set(value.keys) == Set(["active", "previous"]),
    let active = value["active"] as? String,
    isMobileWebSha256(active)
  else {
    return nil
  }
  let previous: String?
  if value.keys.contains("previous") {
    guard
      let candidate = value["previous"] as? String,
      isMobileWebSha256(candidate),
      candidate != active
    else {
      return nil
    }
    previous = candidate
  } else {
    previous = nil
  }
  return MobileWebActivationRecord(active: active, previous: previous)
}
