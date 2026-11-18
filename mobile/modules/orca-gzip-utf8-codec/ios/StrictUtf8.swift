import Foundation

/// Decode only well-formed UTF-8 without a leading BOM; JS TextDecoder owns replacement/BOM behavior.
func decodeStrictUtf8(_ input: Data) -> String? {
  if input.starts(with: [0xef, 0xbb, 0xbf]) {
    return nil
  }
  return String(data: input, encoding: .utf8)
}
