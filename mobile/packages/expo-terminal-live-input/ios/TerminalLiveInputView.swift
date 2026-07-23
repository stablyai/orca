import ExpoModulesCore
import UIKit

private final class TerminalLiveTextField: UITextField {
  var onDeleteBackwardAtEmpty: (() -> Void)?

  override func deleteBackward() {
    if (text ?? "").isEmpty {
      onDeleteBackwardAtEmpty?()
    }
    super.deleteBackward()
  }
}

/**
 * Hosts a UITextField that only forwards committed text to JS.
 * Marked-text (Japanese/Chinese IME preedit) is never emitted until composition ends.
 */
public class TerminalLiveInputView: ExpoView, UITextFieldDelegate {
  let onCommittedText = EventDispatcher()
  let onInputFocus = EventDispatcher()
  let onInputBlur = EventDispatcher()
  let onKeyPress = EventDispatcher()
  let onTerminalEnter = EventDispatcher()

  private let textField = TerminalLiveTextField()
  private var lastEmittedText: String = ""
  private var hadMarkedText = false
  private var isSettingTextProgrammatically = false
  // Why: IME 確定 often delivers Return in the same turn as unmark; suppress that Enter only.
  private var suppressTerminalEnter = false
  private var suppressTerminalEnterGeneration = 0

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = true

    textField.translatesAutoresizingMaskIntoConstraints = false
    textField.backgroundColor = .clear
    textField.borderStyle = .none
    textField.autocorrectionType = .no
    textField.autocapitalizationType = .none
    textField.spellCheckingType = .no
    textField.smartDashesType = .no
    textField.smartQuotesType = .no
    textField.smartInsertDeleteType = .no
    textField.keyboardType = .default
    textField.returnKeyType = .default
    textField.enablesReturnKeyAutomatically = false
    // Why: leave textContentType unset so multilingual IMEs stay available (no email/username narrowing).
    textField.delegate = self
    textField.addTarget(self, action: #selector(handleEditingChanged), for: .editingChanged)
    textField.onDeleteBackwardAtEmpty = { [weak self] in
      self?.onKeyPress(["key": "Backspace"])
    }

    addSubview(textField)
    NSLayoutConstraint.activate([
      textField.leadingAnchor.constraint(equalTo: leadingAnchor),
      textField.trailingAnchor.constraint(equalTo: trailingAnchor),
      textField.topAnchor.constraint(equalTo: topAnchor),
      textField.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  func setEditable(_ editable: Bool) {
    textField.isEnabled = editable
  }

  func focusField() -> Bool {
    textField.becomeFirstResponder()
    return textField.isFirstResponder
  }

  func blurField() -> Bool {
    textField.resignFirstResponder()
    return !textField.isFirstResponder
  }

  func setText(_ text: String) {
    isSettingTextProgrammatically = true
    textField.unmarkText()
    hadMarkedText = false
    clearTerminalEnterSuppression()
    textField.text = text
    lastEmittedText = text
    isSettingTextProgrammatically = false
  }

  @objc private func handleEditingChanged() {
    if isSettingTextProgrammatically {
      return
    }

    let hasMarked = textField.markedTextRange != nil
    if hasMarked {
      hadMarkedText = true
      return
    }

    if hadMarkedText {
      // Why: composition just ended; a following Return is IME confirm, not terminal Enter.
      armTerminalEnterSuppression()
      hadMarkedText = false
    }

    emitCommittedSnapshotIfNeeded()
  }

  private func emitCommittedSnapshotIfNeeded() {
    let text = textField.text ?? ""
    if text == lastEmittedText {
      return
    }
    lastEmittedText = text
    onCommittedText(["text": text])
  }

  private func armTerminalEnterSuppression() {
    suppressTerminalEnterGeneration += 1
    let generation = suppressTerminalEnterGeneration
    suppressTerminalEnter = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      guard let self, self.suppressTerminalEnterGeneration == generation else {
        return
      }
      self.suppressTerminalEnter = false
    }
  }

  private func clearTerminalEnterSuppression() {
    suppressTerminalEnterGeneration += 1
    suppressTerminalEnter = false
  }

  public func textField(
    _ textField: UITextField,
    shouldChangeCharactersIn range: NSRange,
    replacementString string: String
  ) -> Bool {
    let current = textField.text ?? ""
    if string.isEmpty && range.length == 0 && current.isEmpty {
      // TerminalLiveTextField reports this path because no editingChanged event follows.
      return false
    }
    return true
  }

  public func textFieldDidBeginEditing(_ textField: UITextField) {
    onInputFocus([:])
  }

  public func textFieldDidEndEditing(_ textField: UITextField) {
    onInputBlur([:])
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    if textField.markedTextRange != nil || hadMarkedText {
      // Why: the first Return confirms multistage text; it must not also reach the PTY.
      textField.unmarkText()
      hadMarkedText = false
      armTerminalEnterSuppression()
      emitCommittedSnapshotIfNeeded()
      return false
    }
    if suppressTerminalEnter {
      clearTerminalEnterSuppression()
      // Why: keep focus so the next keystroke continues the live field session.
      return false
    }
    onTerminalEnter([:])
    return false
  }
}
