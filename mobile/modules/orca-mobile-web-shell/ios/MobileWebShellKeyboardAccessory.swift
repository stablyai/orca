import ObjectiveC
import UIKit
import WebKit

/// Remove the accessory bar via a content-view subclass (react-native-webview’s technique); its height otherwise lifts the page twice.
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

/// Suppress WebKit’s keyboard scrolling: the shell already reports the height used to lift the page.
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
