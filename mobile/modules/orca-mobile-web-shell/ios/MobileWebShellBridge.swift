import Foundation

/// Shared page/native bridge contract; framework-free for off-device checks.
enum MobileWebShellBridge {
  /// Use the same injected global/handler name on Android and iOS.
  static let handlerName = "orcaBridge"

  /// Enforce the shared UTF-8 JSON byte ceiling natively, before parsing.
  static let maxMessageByteCount = 640 * 1024

  /// Simulator 2026-09-18: WebKit lowercases custom-scheme hosts; use the request predicate’s ASCII-only fold for mixed-case base64url ids.
  static func accepts(_ source: MobileWebShellBridgeSource, sessionId: String) -> Bool {
    guard
      source.isOurWebView,
      source.isMainFrame,
      source.hasCommittedDocument,
      source.originProtocol == MobileWebShellOrigin.scheme,
      MobileWebShellOrigin.isValidSessionId(sessionId),
      MobileWebShellOrigin.asciiLowercased(source.originHost)
        == MobileWebShellOrigin.asciiLowercased(sessionId)
    else { return false }
    return true
  }

  /// WebKit has no reply proxy: post only to the last accepted frame while its document is committed. WKFrameInfo outlives its frame.
  static func canPost(
    toFrameOriginHost host: String?,
    sessionId: String,
    hasCommittedDocument: Bool
  ) -> Bool {
    guard
      hasCommittedDocument,
      let host,
      MobileWebShellOrigin.isValidSessionId(sessionId),
      MobileWebShellOrigin.asciiLowercased(host)
        == MobileWebShellOrigin.asciiLowercased(sessionId)
    else { return false }
    return true
  }

  static func acceptsByteCount(_ byteCount: Int) -> Bool {
    byteCount <= maxMessageByteCount
  }
}

/// Bind frame and reported host atomically; every document boundary clears them, requiring the new page to speak before a native post.
struct MobileWebShellBridgeTarget<Frame> {
  private var armed: (frame: Frame, originHost: String)?

  var frame: Frame? { armed?.frame }
  var originHost: String? { armed?.originHost }

  mutating func arm(frame: Frame, originHost: String) {
    armed = (frame: frame, originHost: originHost)
  }

  mutating func clear() {
    armed = nil
  }
}

/// A script message reduced to what the predicate reads, so the predicate needs no WebKit type.
struct MobileWebShellBridgeSource {
  var isOurWebView: Bool
  var isMainFrame: Bool
  /// Whether a document has committed under the props this message is being judged against.
  var hasCommittedDocument: Bool
  var originProtocol: String
  var originHost: String
}

/// Silently count refusals for tests without revealing the cap to the page.
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
