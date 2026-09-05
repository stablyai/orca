import ExpoModulesCore
import ExpoHardwareKeyboardNavigation
import UIKit

// Captured keys stay in the focused field's responder chain.
public class HardwareKeyboardCaptureView: ExpoView {
  let onHardwareKey = EventDispatcher()
  var enabled: Bool = true
  var captureMode: String = "terminal"

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    isUserInteractionEnabled = true
  }

  public override var canBecomeFirstResponder: Bool {
    return false
  }

  private func focusedTextInput(in view: UIView) -> (UIView & UITextInput)? {
    if view.isFirstResponder, let input = view as? (UIView & UITextInput) {
      return input
    }
    for child in view.subviews {
      if let input = focusedTextInput(in: child) { return input }
    }
    return nil
  }

  // UIKit re-reads this invariant command set for every key event.
  private static let terminalKeyCommands: [UIKeyCommand] = buildTerminalKeyCommands(
    action: #selector(HardwareKeyboardCaptureView.handleKeyCommand(_:))
  )

  public override var keyCommands: [UIKeyCommand]? {
    guard enabled, let input = focusedTextInput(in: self), input.markedTextRange == nil else {
      return nil
    }
    if captureMode == "submit" {
      let command = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(handleKeyCommand(_:)))
      command.wantsPriorityOverSystemBehavior = true
      return [command]
    }
    return Self.terminalKeyCommands.filter {
      !HardwareKeyboardCommandRegistry.shared.owns($0, in: window)
    }
  }

  public override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(handleKeyCommand(_:)) {
      if captureMode == "terminal", let command = sender as? UIKeyCommand,
         HardwareKeyboardCommandRegistry.shared.owns(command, in: window) {
        return false
      }
      guard enabled, let input = focusedTextInput(in: self) else { return false }
      return input.markedTextRange == nil
    }
    return super.canPerformAction(action, withSender: sender)
  }

  @objc func handleKeyCommand(_ sender: UIKeyCommand) {
    if captureMode == "terminal", HardwareKeyboardCommandRegistry.shared.owns(sender, in: window) {
      return
    }
    guard enabled, let textInput = focusedTextInput(in: self), textInput.markedTextRange == nil else {
      return
    }
    // Why: Meta/Command stays system-owned (copy/paste/select-all).
    if sender.modifierFlags.contains(.command) {
      return
    }
    let input = sender.input ?? ""
    // Why: never claim Ctrl+Space — system input-method switching.
    if sender.modifierFlags.contains(.control) && input == " " {
      return
    }
    let key = captureMode == "submit" ? "Enter" : Self.canonicalKey(fromInput: input)
    // UIKeyCommand repeats callbacks but does not expose repeat state.
    onHardwareKey([
      "key": key,
      "modifiers": [
        "ctrl": sender.modifierFlags.contains(.control),
        "alt": sender.modifierFlags.contains(.alternate),
        "shift": sender.modifierFlags.contains(.shift),
        "meta": false
      ],
      "repeat": false
    ])
  }

  private static func buildTerminalKeyCommands(action: Selector) -> [UIKeyCommand] {
    var commands: [UIKeyCommand] = []

    let specials: [String] = [
      UIKeyCommand.inputUpArrow,
      UIKeyCommand.inputDownArrow,
      UIKeyCommand.inputLeftArrow,
      UIKeyCommand.inputRightArrow,
      UIKeyCommand.inputEscape,
      "\t",
      UIKeyCommand.inputDelete,
      "\u{7f}",
    ]

    var homeEndPage: [String] = []
    if #available(iOS 15.0, *) {
      homeEndPage = [
        UIKeyCommand.inputHome,
        UIKeyCommand.inputEnd,
        UIKeyCommand.inputPageUp,
        UIKeyCommand.inputPageDown
      ]
    }

    let modifierSets: [UIKeyModifierFlags] = [
      [],
      [.shift],
      [.control],
      [.alternate],
      [.shift, .control],
      [.shift, .alternate],
      [.control, .alternate],
      [.shift, .control, .alternate]
    ]

    for input in specials + homeEndPage {
      for modifiers in modifierSets where !modifiers.contains(.command) {
        let command = UIKeyCommand(input: input, modifierFlags: modifiers, action: action)
        if #available(iOS 15.0, *) {
          command.wantsPriorityOverSystemBehavior = true
        }
        commands.append(command)
      }
    }

    // Official function-key inputs (available at this package's iOS 15.1 floor).
    let fKeys: [String] = [
      UIKeyCommand.f1, UIKeyCommand.f2, UIKeyCommand.f3, UIKeyCommand.f4,
      UIKeyCommand.f5, UIKeyCommand.f6, UIKeyCommand.f7, UIKeyCommand.f8,
      UIKeyCommand.f9, UIKeyCommand.f10, UIKeyCommand.f11, UIKeyCommand.f12
    ]
    for input in fKeys {
      for modifiers in modifierSets where !modifiers.contains(.command) {
        let command = UIKeyCommand(input: input, modifierFlags: modifiers, action: action)
        if #available(iOS 15.0, *) {
          command.wantsPriorityOverSystemBehavior = true
        }
        commands.append(command)
      }
    }

    // Keep Option text and Ctrl+Space owned by the input method.
    let letters = (UnicodeScalar("a").value...UnicodeScalar("z").value).map {
      String(UnicodeScalar($0)!)
    }
    let controlPunctuation = ["@", "`", "[", "{", "\\", "|", "]", "}", "^", "~", "_", "?"]
    let controlModifierSets: [UIKeyModifierFlags] = [.control, [.control, .shift]]
    for input in letters + controlPunctuation {
      for modifiers in controlModifierSets {
        let command = UIKeyCommand(input: input, modifierFlags: modifiers, action: action)
        command.wantsPriorityOverSystemBehavior = true
        commands.append(command)
      }
    }

    return commands
  }

  private static func canonicalKey(fromInput input: String) -> String {
    switch input {
    case UIKeyCommand.inputUpArrow: return "ArrowUp"
    case UIKeyCommand.inputDownArrow: return "ArrowDown"
    case UIKeyCommand.inputLeftArrow: return "ArrowLeft"
    case UIKeyCommand.inputRightArrow: return "ArrowRight"
    case UIKeyCommand.inputEscape: return "Escape"
    case "\t": return "Tab"
    case UIKeyCommand.inputDelete: return "Backspace"
    case "\u{7f}": return "Delete"
    case UIKeyCommand.f1: return "F1"
    case UIKeyCommand.f2: return "F2"
    case UIKeyCommand.f3: return "F3"
    case UIKeyCommand.f4: return "F4"
    case UIKeyCommand.f5: return "F5"
    case UIKeyCommand.f6: return "F6"
    case UIKeyCommand.f7: return "F7"
    case UIKeyCommand.f8: return "F8"
    case UIKeyCommand.f9: return "F9"
    case UIKeyCommand.f10: return "F10"
    case UIKeyCommand.f11: return "F11"
    case UIKeyCommand.f12: return "F12"
    default:
      break
    }
    if #available(iOS 15.0, *) {
      switch input {
      case UIKeyCommand.inputHome: return "Home"
      case UIKeyCommand.inputEnd: return "End"
      case UIKeyCommand.inputPageUp: return "PageUp"
      case UIKeyCommand.inputPageDown: return "PageDown"
      default: break
      }
    }
    return input
  }
}
