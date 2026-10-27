import ExpoModulesCore
import UIKit

// iPadOS 26 window controls overlap the plain safe area; fold the corner-adapted inset into the root so all headers clear them.
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

/// Measure window resize/safe-area changes outside the root’s extra inset to avoid feedback.
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
