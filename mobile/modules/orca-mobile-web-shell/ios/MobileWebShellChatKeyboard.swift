import UIKit
import WebKit

private let chatKeyboardPolicy = """
  (function(){
    var composing=false;
    var sink=window.webkit.messageHandlers.orcaChatKeyboard;
    function update(){
      var field=document.activeElement;
      sink.postMessage(!composing && field instanceof HTMLTextAreaElement &&
        field.getAttribute('data-orca-hardware-enter-to-send')==='true');
    }
    document.addEventListener('focusin',update);
    document.addEventListener('focusout',function(){sink.postMessage(false)});
    document.addEventListener('compositionstart',function(){composing=true;update()});
    document.addEventListener('compositionend',function(){composing=false;update()});
    document.addEventListener('orca-chat-keyboard-policy',update);
    window.addEventListener('pagehide',function(){sink.postMessage(false)});
    sink.postMessage(false);
  })();
  """

private final class ChatKeyboardReceiver: NSObject, WKScriptMessageHandler {
  weak var view: MobileWebShellChatWebView?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, message.webView === view,
      let enabled = message.body as? Bool else { return }
    view?.acceptsChatReturn = enabled
  }
}

/// A software Return has the same DOM code as hardware on iOS; only a UIKit key command proves hardware.
final class MobileWebShellChatWebView: WKWebView {
  fileprivate var acceptsChatReturn = false
  private let keyboardReceiver = ChatKeyboardReceiver()
  private lazy var chatReturn: UIKeyCommand = {
    let command = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(sendChatReturn))
    command.wantsPriorityOverSystemBehavior = true
    return command
  }()

  override init(frame: CGRect, configuration: WKWebViewConfiguration) {
    configuration.userContentController.add(keyboardReceiver, name: "orcaChatKeyboard")
    configuration.userContentController.addUserScript(Self.keyboardPolicyScript())
    super.init(frame: frame, configuration: configuration)
    keyboardReceiver.view = self
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func keyboardPolicyScript() -> WKUserScript {
    WKUserScript(source: chatKeyboardPolicy, injectionTime: .atDocumentStart, forMainFrameOnly: true)
  }

  func resetChatKeyboard() { acceptsChatReturn = false }

  override var keyCommands: [UIKeyCommand]? { (super.keyCommands ?? []) + [chatReturn] }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(sendChatReturn) {
      return acceptsChatReturn && !hasMarkedText(in: self)
    }
    return super.canPerformAction(action, withSender: sender)
  }

  private func hasMarkedText(in view: UIView) -> Bool {
    if view.isFirstResponder, let input = view as? UITextInput, input.markedTextRange != nil {
      return true
    }
    return view.subviews.contains { hasMarkedText(in: $0) }
  }

  @objc private func sendChatReturn() {
    guard acceptsChatReturn, !hasMarkedText(in: self) else { return }
    evaluateJavaScript("""
      document.activeElement?.dispatchEvent(new Event('orca-chat-hardware-return'))
      """, completionHandler: nil)
  }
}
