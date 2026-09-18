import Foundation

/// The page ↔ native message channel: what it is called, how big a message may be, and the
/// predicate that decides whether a script message came from the document we served.
///
/// Framework-free on purpose: `tests/MobileWebShellChecks.swift` compiles this file with `swiftc`
/// and checks it without a device or a simulator.
enum MobileWebShellBridge {
  /// The `WKScriptMessageHandler` name and the global the document-start script installs. Android
  /// uses the same name for its `WebMessageListener`, so one page reaches both shells.
  static let handlerName = "orcaBridge"

  /// Measured on the raw JSON string in UTF-8, before anything parses it. The TypeScript contract
  /// holds the same ceiling; native is the one that cannot be talked out of it.
  static let maxMessageByteCount = 640 * 1024

  /// Simulator-verified 2026-09-18: `WKFrameInfo.securityOrigin` does populate for a custom scheme,
  /// but WebKit ASCII-lowercases the host, so `orca-mobile-web://sess-01JN_aZ9/` reports host
  /// `sess-01jn_az9`. Session ids are base64url and mixed case, so exact equality would refuse every
  /// message. Folding is ASCII-only and never Unicode: U+212A KELVIN SIGN case-folds to `k` under
  /// `NSString.caseInsensitiveCompare`, which would let a host we never minted match one we did.
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

  /// Every clause is an allow, so a message shape nobody anticipated is refused rather than passed.
  static func accepts(_ source: MobileWebShellBridgeSource, sessionId: String) -> Bool {
    guard
      source.isOurWebView,
      source.isMainFrame,
      source.originProtocol == MobileWebShellOrigin.scheme,
      MobileWebShellOrigin.isValidSessionId(sessionId),
      asciiLowercased(source.originHost) == asciiLowercased(sessionId)
    else { return false }
    return true
  }

  static func acceptsByteCount(_ byteCount: Int) -> Bool {
    byteCount <= maxMessageByteCount
  }
}

/// A script message reduced to what the predicate reads, so the predicate needs no WebKit type.
struct MobileWebShellBridgeSource {
  var isOurWebView: Bool
  var isMainFrame: Bool
  var originProtocol: String
  var originHost: String
}

/// Refusal is silent: the shell exposes no new state and tells the page nothing, because a page that
/// learns which messages were dropped learns the cap. The tally is what a test can hold the cap to.
final class MobileWebShellBridgeGate {
  private(set) var refusedCount = 0

  func accepts(byteCount: Int) -> Bool {
    guard MobileWebShellBridge.acceptsByteCount(byteCount) else {
      refusedCount += 1
      return false
    }
    return true
  }
}
