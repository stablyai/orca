import Foundation

// The codec's decisions, compiled and run without a device, from the module directory:
//
//   swiftc -O -o /tmp/gzip-utf8-codec-checks ios/BoundedGunzip.swift \
//     tests/GzipUtf8CodecChecks.swift && /tmp/gzip-utf8-codec-checks
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
    for vector in vectors where [
      "one member", "reaches the limit", "bomb", "bad CRC", "trailing data", "truncated body"
    ].contains(vector["name"] as? String ?? "") {
      let name = vector["name"] as! String
      let expected = (vector["native"] as? String).map { bytes(hex: $0) }
      let actual = try? gunzipBounded(
        bytes(hex: vector["gzipHex"] as! String), outputLimit: vector["outputLimit"] as! Int)
      check(actual == expected, "gunzip: \(name)")
    }

    print(failures == 0 ? "all checks passed" : "\(failures) check(s) failed")
    exit(failures == 0 ? 0 : 1)
  }
}
