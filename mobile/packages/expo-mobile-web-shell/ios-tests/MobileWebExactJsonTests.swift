import Foundation

enum MobileWebExactJsonTests {
  static func run() {
    let valid = [
      "{}",
      #"{"a":1,"b":[true,false,null,{"c":"\u0063"}]}"#,
      #"{"a":-1.25e+2}"#,
      #"{"emoji":"\uD83D\uDE00"}"#,
      #"{"emoji":"😀"}"#,
      nestedObject(depth: 32),
    ]
    precondition(valid.allSatisfy(isExactMobileWebJsonDocument))

    let invalid = [
      "",
      #"{"a":1} trailing"#,
      #"{"a":1,"a":1}"#,
      #"{"a":1,"\u0061":2}"#,
      #"{"a":{"b":1,"b":2}}"#,
      #"[{"a":1,"a":2}]"#,
      #"{"a":01}"#,
      #"{"a":+1}"#,
      #"{"a":1٢}"#,
      #"{"a":1,}"#,
      #"{"a":"\x"}"#,
      #"{"a":"\uD800"}"#,
      #"{"a":"\uDC00"}"#,
      #"{"a":"\uD800\uD800"}"#,
      #"{"\uD800":1}"#,
      nestedObject(depth: 33),
    ]
    precondition(invalid.allSatisfy { !isExactMobileWebJsonDocument($0) })
  }

  private static func nestedObject(depth: Int) -> String {
    String(repeating: #"{"a":"#, count: depth)
      + "0"
      + String(repeating: "}", count: depth)
  }
}
