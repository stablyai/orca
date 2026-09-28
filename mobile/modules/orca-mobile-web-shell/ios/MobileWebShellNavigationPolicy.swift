import Foundation

/// What the shell does with one navigation: the whole decision, so the "allow it" half and the
/// "offer it to the opener" half cannot drift apart.
enum MobileWebShellNavigationVerdict: Equatable {
  /// The served document loading itself, which is the only navigation this WebView performs.
  case allow
  /// Refused, and the host is told nothing. Every navigation was this before the preview existed.
  case cancel
  /// Refused, and the URL is handed to the host's opener, which decides what may open.
  case cancelAndOffer(String)
}

/// The rule for a navigation the shell is deciding about.
///
/// Framework-free on purpose, like `MobileWebShellOrigin`: `tests/MobileWebShellChecks.swift`
/// compiles this file with `swiftc` and checks it without a device or a simulator. Kept in step with
/// the Kotlin copy.
enum MobileWebShellNavigationPolicy {
  /// Longest URL the shell hands back to JS for a cancelled navigation.
  ///
  /// The page's own bound is `BRIDGE_MAX_EXTERNAL_LINK_CHARS` (2048) and the filter that applies it
  /// is `readBridgeExternalLinkUrl`, in TypeScript. This is not a second copy of that rule: it is a
  /// cap on what crosses the native boundary at all, so an artifact cannot spend the bridge on a URL
  /// the opener will refuse anyway.
  static let maxCancelledNavigationUrlCharacters = 4096

  /// The whole decision.
  ///
  /// Three rules, in this order, and the order is the design.
  ///
  /// A navigation outside the main frame is the sealed preview frame loading itself. It is refused
  /// and never offered: forwarding it would let an artifact ask for a browser with no tap behind it.
  ///
  /// **The document URL loads only when the shell asked for it.** `isShellLoad` is a flag the view
  /// raises around its own `webView.load` and drops at commit; nothing else can raise it. Every
  /// other navigation that names the document is refused and never offered -- offering the shell's
  /// own URL to the opener would send the user out of the app instead of reloading it.
  ///
  /// The rule deliberately does not rest on the host reporting a gesture. Measured against a real
  /// WKWebView, off-device: a sandboxed subframe navigating the top frame to the document URL
  /// arrives as `.other` with no gesture at all, and under a gesture-shaped rule that is an allow
  /// and a shell reload -- the bridge target cleared, the load state restarted, the page's state
  /// gone. `isFromSubframe` is the second discriminator for the same reason: the same probe shows
  /// the shell's own load arriving with source and target both the main frame, and a subframe's top
  /// navigation arriving with the subframe as its source.
  ///
  /// What is left for the gesture is the only thing an artifact may ask for: a foreign URL, which
  /// is refused and handed to the opener. A download is not a document load, so it takes that path
  /// too, which is what makes `<a download>` behave the way it does on the native screens -- but a
  /// download that still names the document takes the rule above and is refused without an offer,
  /// because `<a href="/" download>` is the shell's own URL however it is dressed.
  ///
  /// Which URLs may actually open is not decided here -- `readBridgeExternalLinkUrl` owns the scheme
  /// list, in the half that ships over the air.
  static func verdict(
    url: String?,
    isMainFrame: Bool,
    isFromSubframe: Bool,
    isDocumentUrl: Bool,
    isShellLoad: Bool,
    hasGesture: Bool,
    isDownload: Bool
  ) -> MobileWebShellNavigationVerdict {
    guard isMainFrame else {
      return .cancel
    }
    if isDocumentUrl {
      return isShellLoad && !isFromSubframe && !isDownload ? .allow : .cancel
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
