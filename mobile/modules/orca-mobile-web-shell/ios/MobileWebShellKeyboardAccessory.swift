import ObjectiveC
import UIKit
import WebKit

/// Removes WKWebView's form accessory bar (up, down, done). Native screens have none, and the
/// keyboard event the shell publishes counts it, so the page lifted by the bar as well. WebKit
/// exposes no switch, so the content view is moved onto a subclass whose `inputAccessoryView` is
/// nil, the same technique react-native-webview's `hideKeyboardAccessoryView` uses.
func hideKeyboardAccessoryBar(of webView: WKWebView) {
  guard
    let content = webView.scrollView.subviews.first(where: {
      String(describing: type(of: $0)).hasPrefix("WKContent")
    })
  else {
    return
  }
  let base: AnyClass = type(of: content)
  let name = "\(NSStringFromClass(base))_OrcaNoAccessory"
  let subclass: AnyClass
  if let existing = NSClassFromString(name) {
    subclass = existing
  } else {
    guard let created = objc_allocateClassPair(base, name, 0) else {
      return
    }
    let noAccessory: @convention(block) (AnyObject) -> UIView? = { _ in nil }
    let selector = #selector(getter: UIResponder.inputAccessoryView)
    let typeEncoding = method_getTypeEncoding(class_getInstanceMethod(UIResponder.self, selector)!)
    class_addMethod(created, selector, imp_implementationWithBlock(noAccessory), typeEncoding)
    objc_registerClassPair(created)
    subclass = created
  }
  object_setClass(content, subclass)
}

/// Stops WKWebView reacting to the keyboard itself. It listens for the keyboard's frame and scrolls
/// the document to reveal the focused field, on top of the lift the page already applies from the
/// height the shell sends, so the page moved twice. The shell's own listeners are unaffected.
func ignoreKeyboardNotifications(in webView: WKWebView) {
  for name in [
    UIResponder.keyboardWillShowNotification,
    UIResponder.keyboardDidShowNotification,
    UIResponder.keyboardWillHideNotification,
    UIResponder.keyboardDidHideNotification,
    UIResponder.keyboardWillChangeFrameNotification,
    UIResponder.keyboardDidChangeFrameNotification
  ] {
    NotificationCenter.default.removeObserver(webView, name: name, object: nil)
  }
}
