// Prints each screen's notch geometry as JSON and exits.
//
// Why this exists: Electron's Display object exposes bounds, workArea and scaleFactor but
// nothing about the camera housing — no safe-area insets, no auxiliary areas. Menu-bar height
// (workArea.y - bounds.y) hints that a notch exists but never gives its width, which is what
// the status bar's wings, shoulders and camera scrim are all measured against. NSScreen has
// the real numbers; this is the smallest possible way to read them.
//
// Horizontal positions are emitted as offsets from the screen's own frame origin, not in
// AppKit's global space, so the caller can add Electron's display.bounds.x without having to
// reconcile two different multi-display coordinate systems.
import AppKit
import Foundation

struct ScreenGeometry: Encodable {
  let displayId: UInt32
  let width: Double
  let height: Double
  let backingScaleFactor: Double
  let safeAreaTop: Double
  /// Distance from the screen's left edge to the cutout's left edge; null when there is none.
  let notchLeadingOffsetX: Double?
  let notchTrailingOffsetX: Double?
}

func displayId(for screen: NSScreen) -> UInt32? {
  let key = NSDeviceDescriptionKey("NSScreenNumber")
  return (screen.deviceDescription[key] as? NSNumber)?.uint32Value
}

func geometry(for screen: NSScreen) -> ScreenGeometry? {
  guard let id = displayId(for: screen) else { return nil }

  var safeAreaTop = 0.0
  var leading: Double?
  var trailing: Double?

  if #available(macOS 12.0, *) {
    safeAreaTop = Double(screen.safeAreaInsets.top)
    // The cutout is the gap between the two usable top areas. Both are nil on a screen
    // without a camera housing, which is exactly how we detect the pill case.
    if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
      leading = Double(left.maxX - screen.frame.minX)
      trailing = Double(right.minX - screen.frame.minX)
    }
  }

  return ScreenGeometry(
    displayId: id,
    width: Double(screen.frame.width),
    height: Double(screen.frame.height),
    backingScaleFactor: Double(screen.backingScaleFactor),
    safeAreaTop: safeAreaTop,
    notchLeadingOffsetX: leading,
    notchTrailingOffsetX: trailing
  )
}

let screens = NSScreen.screens.compactMap(geometry(for:))
let encoder = JSONEncoder()
if let data = try? encoder.encode(["displays": screens]),
  let json = String(data: data, encoding: .utf8)
{
  print(json)
} else {
  print("{\"displays\":[]}")
}
