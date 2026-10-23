import Foundation

/// Well-formed UTF-8 with no leading BOM, decoded; nil otherwise. Those are the only inputs where
/// every decoder agrees, so the caller hands anything else to the JS TextDecoder for its
/// replacement and BOM rules.
func decodeStrictUtf8(_ input: Data) -> String? {
  if input.starts(with: [0xef, 0xbb, 0xbf]) {
    return nil
  }
  return String(data: input, encoding: .utf8)
}
