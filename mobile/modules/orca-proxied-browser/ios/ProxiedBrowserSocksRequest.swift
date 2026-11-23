import Foundation

/// SOCKS5 handshake (RFC 1928) with username/password auth (RFC 1929); bytes arrive in arbitrary chunks.
enum ProxiedBrowserSocksStep: Equatable {
  case needMore
  case reply(Data)
  case connect(host: String, port: Int)
  case fail(Data?)
}

struct ProxiedBrowserSocksRequest {
  static let version: UInt8 = 5
  static let userPasswordMethod: UInt8 = 2
  static let noAcceptableMethod: UInt8 = 0xff

  enum Phase { case greeting, auth, request }

  private(set) var phase: Phase = .greeting
  let username: Data
  let password: Data

  init(username: Data, password: Data) {
    self.username = username
    self.password = password
  }

  /// Advances over `buffer` from its start; returns the step and how many bytes it consumed.
  mutating func advance(_ buffer: Data) -> (ProxiedBrowserSocksStep, Int) {
    let bytes = [UInt8](buffer)
    switch phase {
    case .greeting:
      guard bytes.count >= 2 else { return (.needMore, 0) }
      guard bytes[0] == Self.version else { return (.fail(nil), 0) }
      let count = Int(bytes[1])
      guard bytes.count >= 2 + count else { return (.needMore, 0) }
      guard bytes[2..<(2 + count)].contains(Self.userPasswordMethod) else {
        return (.fail(Data([Self.version, Self.noAcceptableMethod])), 0)
      }
      phase = .auth
      return (.reply(Data([Self.version, Self.userPasswordMethod])), 2 + count)
    case .auth:
      guard bytes.count >= 2 else { return (.needMore, 0) }
      guard bytes[0] == 1 else { return (.fail(nil), 0) }
      let userLength = Int(bytes[1])
      guard bytes.count >= 3 + userLength else { return (.needMore, 0) }
      let passwordLength = Int(bytes[2 + userLength])
      let end = 3 + userLength + passwordLength
      guard bytes.count >= end else { return (.needMore, 0) }
      let user = Data(bytes[2..<(2 + userLength)])
      let pass = Data(bytes[(3 + userLength)..<end])
      guard constantTimeEqual(user, username), constantTimeEqual(pass, password) else {
        return (.fail(Data([1, 1])), 0)
      }
      phase = .request
      return (.reply(Data([1, 0])), end)
    case .request:
      return parseConnect(bytes)
    }
  }

  private func parseConnect(_ bytes: [UInt8]) -> (ProxiedBrowserSocksStep, Int) {
    guard bytes.count >= 5 else { return (.needMore, 0) }
    guard bytes[0] == Self.version, bytes[2] == 0 else { return (.fail(nil), 0) }
    // Only CONNECT: web views never bind or relay UDP through the proxy.
    guard bytes[1] == 1 else { return (.fail(Self.failureReply(7)), 0) }
    let hostStart: Int
    let hostEnd: Int
    switch bytes[3] {
    case 1:
      hostStart = 4
      hostEnd = 8
    case 3:
      hostStart = 5
      hostEnd = 5 + Int(bytes[4])
    case 4:
      hostStart = 4
      hostEnd = 20
    default:
      return (.fail(Self.failureReply(8)), 0)
    }
    guard bytes.count >= hostEnd + 2 else { return (.needMore, 0) }
    let hostBytes = Array(bytes[hostStart..<hostEnd])
    let host: String
    switch bytes[3] {
    case 1:
      host = hostBytes.map(String.init).joined(separator: ".")
    case 4:
      host = stride(from: 0, to: 16, by: 2)
        .map { String(format: "%x", (Int(hostBytes[$0]) << 8) | Int(hostBytes[$0 + 1])) }
        .joined(separator: ":")
    default:
      guard let name = String(bytes: hostBytes, encoding: .utf8), !name.isEmpty else {
        return (.fail(Self.failureReply(1)), 0)
      }
      host = name
    }
    let port = (Int(bytes[hostEnd]) << 8) | Int(bytes[hostEnd + 1])
    return (.connect(host: host, port: port), hostEnd + 2)
  }

  /// Reply with an unspecified IPv4 bound address; clients ignore it for CONNECT.
  static func failureReply(_ code: UInt8) -> Data {
    Data([version, code, 0, 1, 0, 0, 0, 0, 0, 0])
  }

  static let successReply = failureReply(0)

  private func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    var difference: UInt8 = 0
    for (left, right) in zip(lhs, rhs) {
      difference |= left ^ right
    }
    return difference == 0
  }
}
