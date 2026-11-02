import UIKit

@MainActor
internal enum MobileWebShellKeyboardWarmup {
  private static var readyAt: TimeInterval?

  static func prepare(in window: UIWindow) -> TimeInterval {
    if let readyAt {
      return max(0, readyAt - ProcessInfo.processInfo.systemUptime)
    }
    for scene in UIApplication.shared.connectedScenes {
      guard let scene = scene as? UIWindowScene else { continue }
      if scene.windows.contains(where: containsFirstResponder) { return 0 }
    }
    let field = UITextField(frame: CGRect(x: -100, y: -100, width: 40, height: 30))
    field.isAccessibilityElement = false
    field.accessibilityElementsHidden = true
    window.addSubview(field)
    var focused = false
    // iOS split-keyplane initialization crashes on first WebKit focus: developer.apple.com/forums/thread/845347.
    UIView.performWithoutAnimation {
      focused = field.becomeFirstResponder()
      field.resignFirstResponder()
    }
    field.removeFromSuperview()
    guard focused else { return 0 }
    readyAt = ProcessInfo.processInfo.systemUptime + 0.3
    return 0.3
  }

  private static func containsFirstResponder(_ view: UIView) -> Bool {
    view.isFirstResponder || view.subviews.contains(where: containsFirstResponder)
  }
}
