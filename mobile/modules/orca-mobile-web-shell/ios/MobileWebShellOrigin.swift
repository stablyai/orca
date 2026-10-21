import Foundation

/// The private origin a generation is served from, and the predicate that guards it.
///
/// Framework-free on purpose: `tests/MobileWebShellChecks.swift` compiles this file with `swiftc`
/// and checks it without a device or a simulator.
enum MobileWebShellOrigin {
  /// A scheme WebKit has no handler for, so the origin shares no cookie jar, cache or storage with
  /// anything else in the app. A custom scheme's host is opaque, so the session id is used verbatim.
  static let scheme = "orca-mobile-web"
  static let maxSessionIdLength = 128
  static let maxUrlByteCount = 8 * 1024

  static func isValidSessionId(_ sessionId: String) -> Bool {
    guard !sessionId.isEmpty, sessionId.count <= maxSessionIdLength else { return false }
    return sessionId.allSatisfy { character in
      character.isASCII &&
        (character.isLetter || character.isNumber || character == "-" || character == "_")
    }
  }

  /// Host comparison folds case, because a URL parser canonicalises a host and comparing against
  /// the exact spelling we minted is how the reference lost every asset to a 403. ASCII-only and
  /// never Unicode: U+212A KELVIN SIGN folds to `k` under `NSString.caseInsensitiveCompare`, which
  /// would match a host nobody minted against a session id containing `k`.
  static func asciiLowercased(_ value: String) -> String {
    var scalars = String.UnicodeScalarView()
    for scalar in value.unicodeScalars {
      guard (65...90).contains(scalar.value), let lowered = Unicode.Scalar(scalar.value + 32) else {
        scalars.append(scalar)
        continue
      }
      scalars.append(lowered)
    }
    return String(scalars)
  }

  static func documentUrl(sessionId: String) -> URL? {
    guard isValidSessionId(sessionId) else { return nil }
    return URL(string: "\(scheme)://\(sessionId)/")
  }

  /// The map key for a request we are willing to answer, or nil to refuse. Every clause is an
  /// allow, so a component nobody anticipated falls to refusal rather than through it.
  static func resolveRequestPath(
    _ parts: MobileWebShellRequestParts,
    sessionId: String
  ) -> String? {
    guard
      isValidSessionId(sessionId),
      parts.method == "GET",
      !parts.hasRangeHeader,
      parts.scheme == scheme,
      let host = parts.host,
      asciiLowercased(host) == asciiLowercased(sessionId),
      parts.port == nil,
      parts.user == nil,
      parts.query == nil,
      parts.fragment == nil,
      parts.urlByteCount <= maxUrlByteCount,
      !parts.percentEncodedPath.contains("%")
    else { return nil }
    if parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/" { return "/" }
    guard parts.percentEncodedPath.hasPrefix("/") else { return nil }
    return parts.percentEncodedPath
  }
}

/// A request reduced to the components the predicate reads, so the predicate needs no WebKit type.
struct MobileWebShellRequestParts {
  var method: String
  var hasRangeHeader: Bool
  var scheme: String?
  var host: String?
  var port: Int?
  var user: String?
  var query: String?
  var fragment: String?
  var percentEncodedPath: String
  var urlByteCount: Int

  init(
    method: String,
    hasRangeHeader: Bool,
    scheme: String?,
    host: String?,
    port: Int?,
    user: String?,
    query: String?,
    fragment: String?,
    percentEncodedPath: String,
    urlByteCount: Int
  ) {
    self.method = method
    self.hasRangeHeader = hasRangeHeader
    self.scheme = scheme
    self.host = host
    self.port = port
    self.user = user
    self.query = query
    self.fragment = fragment
    self.percentEncodedPath = percentEncodedPath
    self.urlByteCount = urlByteCount
  }

  init?(url: URL, method: String = "GET", hasRangeHeader: Bool = false) {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    self.init(
      method: method,
      hasRangeHeader: hasRangeHeader,
      scheme: url.scheme,
      host: url.host,
      port: url.port,
      user: url.user,
      query: url.query,
      fragment: url.fragment,
      percentEncodedPath: components.percentEncodedPath,
      urlByteCount: url.absoluteString.utf8.count
    )
  }

  init?(request: URLRequest) {
    guard let url = request.url else { return nil }
    self.init(
      url: url,
      method: request.httpMethod ?? "GET",
      hasRangeHeader: request.value(forHTTPHeaderField: "Range") != nil
    )
  }
}
