import ExpoModulesCore
import UIKit

/**
 * Hosts the RN TextInput as a child so physical keys stay in the responder chain.
 * Emits terminal navigation/control keys via UIKeyCommand; leaves Cmd/Meta and
 * ordinary printable input to the system / TextInput. Does not register
 * Ctrl+Space (IME switcher) or Enter (onSubmitEditing).
 */
public class HardwareKeyboardCaptureView: ExpoView {
  let onHardwareKey = EventDispatcher()
  var enabled: Bool = true

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    isUserInteractionEnabled = true
  }

  public override var canBecomeFirstResponder: Bool {
    return enabled
  }

  public override var keyCommands: [UIKeyCommand]? {
    guard enabled else {
      return nil
    }
    return Self.buildTerminalKeyCommands(action: #selector(handleKeyCommand(_:)))
  }

  @objc func handleKeyCommand(_ sender: UIKeyCommand) {
    guard enabled else {
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
    let key = Self.canonicalKey(fromInput: input)
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
      "\u{8}",
      "\u{7f}",
      UIKeyCommand.inputDelete
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

    // Ctrl + a–z (terminal interrupt/navigation); intentionally omit Ctrl+Space.
    for scalar in UnicodeScalar("a").value...UnicodeScalar("z").value {
      let ch = String(UnicodeScalar(scalar)!)
      let command = UIKeyCommand(input: ch, modifierFlags: .control, action: action)
      if #available(iOS 15.0, *) {
        command.wantsPriorityOverSystemBehavior = true
      }
      commands.append(command)
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
    case "\u{8}", "\u{7f}": return "Backspace"
    case UIKeyCommand.inputDelete: return "Delete"
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
