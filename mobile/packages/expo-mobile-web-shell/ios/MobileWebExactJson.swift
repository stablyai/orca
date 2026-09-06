import Foundation

private let mobileWebJsonDepthLimit = 32

func isExactMobileWebJsonDocument(_ value: String) -> Bool {
  var parser = MobileWebExactJsonParser(bytes: Array(value.utf8))
  return parser.parse()
}

private struct MobileWebExactJsonParser {
  let bytes: [UInt8]
  var index = 0

  mutating func parse() -> Bool {
    skipWhitespace()
    guard parseValue(depth: 0) else { return false }
    skipWhitespace()
    return index == bytes.count
  }

  private mutating func parseValue(depth: Int) -> Bool {
    guard depth <= mobileWebJsonDepthLimit, index < bytes.count else { return false }
    switch bytes[index] {
    case 0x7B:
      return parseObject(depth: depth)
    case 0x5B:
      return parseArray(depth: depth)
    case 0x22:
      return parseStringLiteral() != nil
    case 0x74:
      return consume("true")
    case 0x66:
      return consume("false")
    case 0x6E:
      return consume("null")
    default:
      return parseNumber()
    }
  }

  private mutating func parseObject(depth: Int) -> Bool {
    guard consumeByte(0x7B) else { return false }
    skipWhitespace()
    if consumeByte(0x7D) { return true }
    var keys = Set<String>()
    while true {
      guard
        let literal = parseStringLiteral(),
        let key = decodeString(literal),
        keys.insert(key).inserted
      else {
        return false
      }
      skipWhitespace()
      guard consumeByte(0x3A) else { return false }
      skipWhitespace()
      guard parseValue(depth: depth + 1) else { return false }
      skipWhitespace()
      if consumeByte(0x7D) { return true }
      guard consumeByte(0x2C) else { return false }
      skipWhitespace()
    }
  }

  private mutating func parseArray(depth: Int) -> Bool {
    guard consumeByte(0x5B) else { return false }
    skipWhitespace()
    if consumeByte(0x5D) { return true }
    while true {
      guard parseValue(depth: depth + 1) else { return false }
      skipWhitespace()
      if consumeByte(0x5D) { return true }
      guard consumeByte(0x2C) else { return false }
      skipWhitespace()
    }
  }

  private mutating func parseStringLiteral() -> Range<Int>? {
    guard consumeByte(0x22) else { return nil }
    let start = index - 1
    while index < bytes.count {
      let byte = bytes[index]
      index += 1
      if byte == 0x22 { return start..<index }
      if byte < 0x20 { return nil }
      guard byte == 0x5C else { continue }
      guard index < bytes.count else { return nil }
      let escaped = bytes[index]
      index += 1
      if escaped == 0x75 {
        guard let codeUnit = parseUnicodeCodeUnit() else { return nil }
        if (0xD800...0xDBFF).contains(codeUnit) {
          guard
            consumeByte(0x5C),
            consumeByte(0x75),
            let lowSurrogate = parseUnicodeCodeUnit(),
            (0xDC00...0xDFFF).contains(lowSurrogate)
          else {
            return nil
          }
        } else if (0xDC00...0xDFFF).contains(codeUnit) {
          return nil
        }
      } else if ![0x22, 0x5C, 0x2F, 0x62, 0x66, 0x6E, 0x72, 0x74].contains(escaped) {
        return nil
      }
    }
    return nil
  }

  private mutating func parseUnicodeCodeUnit() -> UInt16? {
    guard index + 4 <= bytes.count else { return nil }
    var codeUnit: UInt16 = 0
    for byte in bytes[index..<(index + 4)] {
      guard let digit = hexValue(byte) else { return nil }
      codeUnit = (codeUnit << 4) | UInt16(digit)
    }
    index += 4
    return codeUnit
  }

  private mutating func parseNumber() -> Bool {
    let start = index
    _ = consumeByte(0x2D)
    guard index < bytes.count else { return false }
    if consumeByte(0x30) {
      if index < bytes.count, isDigit(bytes[index]) { return false }
    } else {
      guard consumeDigits(firstMustBeNonzero: true) else { return false }
    }
    if consumeByte(0x2E), !consumeDigits(firstMustBeNonzero: false) { return false }
    if index < bytes.count, bytes[index] == 0x65 || bytes[index] == 0x45 {
      index += 1
      if index < bytes.count, bytes[index] == 0x2B || bytes[index] == 0x2D {
        index += 1
      }
      guard consumeDigits(firstMustBeNonzero: false) else { return false }
    }
    return index > start
  }

  private mutating func consumeDigits(firstMustBeNonzero: Bool) -> Bool {
    guard
      index < bytes.count,
      firstMustBeNonzero ? isNonzeroDigit(bytes[index]) : isDigit(bytes[index])
    else {
      return false
    }
    index += 1
    while index < bytes.count, isDigit(bytes[index]) { index += 1 }
    return true
  }

  private mutating func consume(_ value: String) -> Bool {
    let expected = Array(value.utf8)
    guard bytes[index...].starts(with: expected) else { return false }
    index += expected.count
    return true
  }

  private mutating func consumeByte(_ byte: UInt8) -> Bool {
    guard index < bytes.count, bytes[index] == byte else { return false }
    index += 1
    return true
  }

  private mutating func skipWhitespace() {
    while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) {
      index += 1
    }
  }

  private func decodeString(_ range: Range<Int>) -> String? {
    let literal = String(decoding: bytes[range], as: UTF8.self)
    guard
      let values = try? JSONSerialization.jsonObject(with: Data("[\(literal)]".utf8))
        as? [String],
      values.count == 1
    else {
      return nil
    }
    return values[0]
  }

  private func isDigit(_ byte: UInt8) -> Bool {
    (0x30...0x39).contains(byte)
  }

  private func isNonzeroDigit(_ byte: UInt8) -> Bool {
    (0x31...0x39).contains(byte)
  }

  private func hexValue(_ byte: UInt8) -> UInt8? {
    if (0x30...0x39).contains(byte) { return byte - 0x30 }
    if (0x41...0x46).contains(byte) { return byte - 0x41 + 10 }
    if (0x61...0x66).contains(byte) { return byte - 0x61 + 10 }
    return nil
  }
}
