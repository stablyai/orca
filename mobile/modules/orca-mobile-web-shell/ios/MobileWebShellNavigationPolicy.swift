import Foundation

/// Keep allow/refuse/opener routing in one decision shared across platforms.
enum MobileWebShellNavigationVerdict: Equatable {
  /// The served document, or a srcdoc or chat visual frame inside it, loading itself.
  case allow
  /// Refused, and the host is told nothing. Every navigation was this before the preview existed.
  case cancel
  /// Refused, and the URL is handed to the host's opener, which decides what may open.
  case cancelAndOffer(String)
}

/// Framework-free navigation policy, checked off-device and kept in sync with Kotlin.
enum MobileWebShellNavigationPolicy {
  /// Cap native-to-JS URL traffic, the tighter bound for cancelled navigations; TypeScript’s readBridgeExternalLinkUrl owns scheme filtering.
  static let maxCancelledNavigationUrlCharacters = 4096

  /// The URL a frame's srcdoc document loads under; it carries the embedder's CSP and the frame's sandbox.
  static let inlineDocumentUrl = "about:srcdoc"

  /// Allow only srcdoc subframes (sealed HTML previews, chat visuals) and the chat visual frame; allow the document only with the one-shot shell-load flag, spent at decision.
  /// Other document URLs (including downloads) are never offered to the opener; gestured foreign URLs may be.
  /// Gestures cannot authorize loads: sandboxed top navigation can report .other without one.
  /// Ignore sourceFrame: WebKit before iOS 18.5 omits it for our own load (c28b242).
  /// TypeScript’s readBridgeExternalLinkUrl owns scheme filtering so OTA policy has one source.
  static func verdict(
    url: String?,
    isMainFrame: Bool,
    isDocumentUrl: Bool,
    isChatVisualFrameUrl: Bool,
    isShellLoad: Bool,
    hasGesture: Bool,
    isDownload: Bool
  ) -> MobileWebShellNavigationVerdict {
    guard isMainFrame else {
      return (url == inlineDocumentUrl || isChatVisualFrameUrl) && !isDownload ? .allow : .cancel
    }
    if isDocumentUrl {
      return isShellLoad && !isDownload ? .allow : .cancel
    }
    guard hasGesture, let offered = offerableUrl(url) else {
      return .cancel
    }
    return .cancelAndOffer(offered)
  }

  /// The URL a cancelled navigation may be offered under, or nil when nothing crosses.
  static func offerableUrl(_ url: String?) -> String? {
    guard let url, !url.isEmpty, url.count <= maxCancelledNavigationUrlCharacters else {
      return nil
    }
    return url
  }
}
