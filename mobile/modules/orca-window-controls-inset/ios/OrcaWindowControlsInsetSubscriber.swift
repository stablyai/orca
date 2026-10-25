import ExpoModulesCore
import UIKit

// Why: on iPadOS 26 a windowed app gets the close/minimize/resize buttons drawn over its
// top-left corner, and the plain safe area does not grow for them, so header buttons sat
// under them. Folding the corner-adapted inset into the root view controller's safe area
// moves every screen below the buttons with no per-screen changes (0 in full screen).
public class OrcaWindowControlsInsetSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let window = application.delegate?.window ?? nil {
      WindowControlsInsetProbe.install(in: window)
    }
    return true
  }
}

/// Invisible full-window view: it is laid out on every window resize and safe-area change,
/// and it measures the window, which the root controller's extra inset never feeds back into.
private final class WindowControlsInsetProbe: UIView {
  private var rootObservation: NSKeyValueObservation?

  static func install(in window: UIWindow) {
    let probe = WindowControlsInsetProbe(frame: window.bounds)
    probe.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    probe.isUserInteractionEnabled = false
    probe.isAccessibilityElement = false
    window.insertSubview(probe, at: 0)
    // The dev launcher and reloads swap the root controller; the new one needs the inset too.
    probe.rootObservation = window.observe(\.rootViewController, options: [.new]) { [weak probe] _, _ in
      probe?.setNeedsLayout()
    }
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let window, let root = window.rootViewController else { return }
    let extraTop = Self.windowControlsTopInset(of: window)
    if root.additionalSafeAreaInsets.top != extraTop {
      root.additionalSafeAreaInsets.top = extraTop
    }
  }

  private static func windowControlsTopInset(of window: UIWindow) -> CGFloat {
    #if compiler(>=6.2)
      if #available(iOS 26.0, *) {
        let adapted = window.edgeInsets(for: .safeArea(cornerAdaptation: .vertical)).top
        return max(0, adapted - window.safeAreaInsets.top)
      }
    #endif
    return 0
  }
}
