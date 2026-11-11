import UIKit

@MainActor
internal enum MobileWebShellKeyboardWarmup {
  enum Preparation {
    case ready(after: TimeInterval)
    case waitingForTextInput
    case failed
  }

  private static var readyAt: TimeInterval?

  static func prepare(in window: UIWindow) -> Preparation {
    if let readyAt {
      return .ready(after: max(0, readyAt - ProcessInfo.processInfo.systemUptime))
    }
    for scene in UIApplication.shared.connectedScenes {
      guard let scene = scene as? UIWindowScene else { continue }
      for sceneWindow in scene.windows {
        if let responder = firstResponder(in: sceneWindow), hasActiveTextInput(responder) {
          return .waitingForTextInput
        }
      }
    }
    let previousResponder = firstResponder(in: window)
    let field = UITextField(frame: CGRect(x: -100, y: -100, width: 40, height: 30))
    field.isAccessibilityElement = false
    field.accessibilityElementsHidden = true
    window.addSubview(field)
    var focused = false
    // iOS split-keyplane initialization crashes on first WebKit focus: developer.apple.com/forums/thread/845347.
    UIView.performWithoutAnimation {
      focused = field.becomeFirstResponder()
      if focused {
        field.resignFirstResponder()
        previousResponder?.becomeFirstResponder()
      }
    }
    field.removeFromSuperview()
    guard focused else { return .failed }
    readyAt = ProcessInfo.processInfo.systemUptime + 0.3
    return .ready(after: 0.3)
  }

  private static func hasActiveTextInput(_ responder: UIView) -> Bool {
    if let field = responder as? UITextField {
      return field.isEditing
    }
    guard let input = responder as? UITextInput else { return false }
    return input.selectedTextRange != nil || input.markedTextRange != nil
  }

  private static func firstResponder(in view: UIView) -> UIView? {
    if view.isFirstResponder { return view }
    for child in view.subviews {
      if let responder = firstResponder(in: child) { return responder }
    }
    return nil
  }
}
