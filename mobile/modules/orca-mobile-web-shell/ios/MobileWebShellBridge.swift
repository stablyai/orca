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

  /// Every clause is an allow, so a message shape nobody anticipated is refused rather than passed.
  ///
  /// Simulator-verified 2026-09-18: `WKFrameInfo.securityOrigin` does populate for a custom scheme,
  /// but WebKit ASCII-lowercases the host, so `orca-mobile-web://sess-01JN_aZ9/` reports host
  /// `sess-01jn_az9`. Session ids are base64url and mixed case, so exact equality would refuse every
  /// message; the fold is `MobileWebShellOrigin.asciiLowercased`, shared with the request predicate.
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

  /// WebKit hands the handler no reply proxy, so a native → page post has to name a frame itself.
  /// The frame is the one the last accepted message came from, and nil is the whole answer for a
  /// page that has never spoken, a load that failed and a renderer that died: a post with nowhere
  /// proven to go is refused, never delivered to whatever frame happens to be current.
  ///
  /// `hasCommittedDocument` is the same arming acceptance reads. Between a new provisional
  /// navigation and its commit there is no document the held frame belongs to, and `WKFrameInfo` is
  /// a snapshot that outlives the frame it describes, so it cannot be asked.
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

/// Where a native post may go: the frame of the last accepted message and the host that frame
/// reported when it spoke. One value, so the frame and the host it is checked against can never be
/// from different documents, and generic over the frame so the rule needs no WebKit type.
///
/// Held for the document that armed it and no longer. Every boundary that ends that document clears
/// it — a new provisional navigation, the commit that replaces it, a load failure, a dead renderer,
/// a prop update — so the document now on screen has to speak before anything is posted to it.
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
