import Foundation

/// What the slots need from a booted document: whether it can still be shown, and how it goes away.
protocol MobileWebShellSparePage: AnyObject {
  var isUsable: Bool { get }
  func destroy()
}

struct MobileWebShellSpareEntry<Page: MobileWebShellSparePage> {
  let buildId: String
  /// The host whose files it reads: the one it booted from, then the one that claimed it.
  let hostKey: String
  let sessionId: String
  let page: Page
}

/// At most one spare parked app-wide, plus claims waiting for their view. Keyed by build, not host:
/// two hosts on one desktop version serve the same bytes. Pure, like the Kotlin copy, so `swiftc`
/// checks it without a device.
final class MobileWebShellSpareSlots<Page: MobileWebShellSparePage> {
  private(set) var parked: MobileWebShellSpareEntry<Page>?
  private var claimed: [String: MobileWebShellSpareEntry<Page>] = [:]

  /// False when a live spare of this build is already parked, or of any build unless `replace`.
  func wants(buildId: String, replace: Bool = true) -> Bool {
    guard let current = parked, current.page.isUsable else { return true }
    return replace && current.buildId != buildId
  }

  /// Replaces whatever is parked.
  func park(_ entry: MobileWebShellSpareEntry<Page>) {
    discardParked()
    parked = entry
  }

  /// Hands the parked spare out once, and only to a screen opening the same build: `directoryBuildId`
  /// is what the claiming screen's directory holds, so a stale or mislabelled directory is refused.
  func take(
    buildId: String,
    directoryBuildId: String?,
    hostKey: String
  ) -> MobileWebShellSpareEntry<Page>? {
    guard let spare = parked, spare.buildId == buildId, directoryBuildId == buildId,
      spare.page.isUsable
    else { return nil }
    parked = nil
    let claim = MobileWebShellSpareEntry(
      buildId: buildId,
      hostKey: hostKey,
      sessionId: spare.sessionId,
      page: spare.page
    )
    claimed[spare.sessionId] = claim
    return claim
  }

  /// Nil, and the page destroyed, when it died between claim and adoption: the view boots its own.
  func adopt(sessionId: String) -> MobileWebShellSpareEntry<Page>? {
    guard let claim = claimed.removeValue(forKey: sessionId) else { return nil }
    guard claim.page.isUsable else {
      claim.page.destroy()
      return nil
    }
    return claim
  }

  /// Whether a spare of this build is parked, before a claim pays for reading the directory.
  func holds(buildId: String) -> Bool {
    parked?.buildId == buildId
  }

  /// A claimed spare no view adopted in time.
  func expire(sessionId: String) {
    claimed.removeValue(forKey: sessionId)?.page.destroy()
  }

  /// Nil for every host.
  func discard(hostKey: String?) {
    if hostKey == nil || parked?.hostKey == hostKey {
      discardParked()
    }
    for (sessionId, entry) in claimed where hostKey == nil || entry.hostKey == hostKey {
      claimed.removeValue(forKey: sessionId)?.page.destroy()
    }
  }

  /// The parked spare's own content process died or its load failed.
  func discardParked(ifSame page: Page) {
    if parked?.page === page {
      discardParked()
    }
  }

  func discardParked() {
    parked?.page.destroy()
    parked = nil
  }
}
