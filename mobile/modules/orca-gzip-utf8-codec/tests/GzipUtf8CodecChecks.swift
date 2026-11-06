import Foundation

// The codec's decisions, compiled and run without a device, from the module directory:
//
//   swiftc -O -o /tmp/gzip-utf8-codec-checks ios/BoundedGunzip.swift \
//     ios/StrictUtf8.swift tests/GzipUtf8CodecChecks.swift && /tmp/gzip-utf8-codec-checks
@main struct GzipUtf8CodecChecks {
  static var failures = 0

  static func check(_ condition: Bool, _ name: String) {
    if !condition {
      failures += 1
      print("FAIL: \(name)")
    }
  }

  static func bytes(hex: String) -> Data {
    var data = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      data.append(UInt8(hex[index..<next], radix: 16)!)
      index = next
    }
    return data
  }

  static func main() throws {
    // Shared with the Kotlin tests and the JS tests, which pin fflate's answer to the same inputs.
    let url = URL(fileURLWithPath: "tests/gunzip-vectors.json")
    let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
    for vector in vectors {
      let name = vector["name"] as! String
      let expected = (vector["native"] as? String).map { bytes(hex: $0) }
      let actual = try? gunzipBounded(
        bytes(hex: vector["gzipHex"] as! String), outputLimit: vector["outputLimit"] as! Int)
      check(actual == expected, "gunzip: \(name)")
    }

    let text = "{\"a\":\"x\u{e9}\u{2713}\u{1F642}\"}"
    check(decodeStrictUtf8(Data(text.utf8)) == text, "utf8: every sequence length")
    check(decodeStrictUtf8(Data()) == "", "utf8: empty")
    let refused: [[UInt8]] = [
      [0xef, 0xbb, 0xbf, 0x41], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0x41, 0xe2, 0x82], [0x80],
      [0xf5, 0x80, 0x80, 0x80],
    ]
    for input in refused {
      check(decodeStrictUtf8(Data(input)) == nil, "utf8: refuses \(input)")
    }

    print(failures == 0 ? "all checks passed" : "\(failures) check(s) failed")
    exit(failures == 0 ? 0 : 1)
  }
}
