import Foundation
// IrohLib.swift is compiled into this same ExpoIroh target (vendored bindings).

enum IrohPathUtils {
  static func label(_ paths: [PathSnapshot]) -> String {
    let selected = paths.first(where: \.isSelected) ?? paths.first
    guard let s = selected else { return "unknown" }
    var kinds: [String] = []
    if s.isIp { kinds.append("direct") }
    if s.isRelay { kinds.append("relayed") }
    if kinds.isEmpty { return "unknown" }
    if kinds.count == 2 { return "mixed" }
    return kinds[0]
  }

  static func detail(_ paths: [PathSnapshot]) -> String {
    if paths.isEmpty { return "(no paths yet)" }
    return paths.map { p in
      let kind = [p.isIp ? "IP" : nil, p.isRelay ? "RELAY" : nil]
        .compactMap { $0 }.joined(separator: "+")
      let mark = p.isSelected ? "*" : " "
      return "\(mark) \(kind) \(p.remoteAddr) rtt=\(p.rttMs)ms"
    }.joined(separator: "\n")
  }

  static func snapshot(_ paths: [PathSnapshot]) -> (pathType: String, detail: String) {
    (label(paths), detail(paths))
  }
}
