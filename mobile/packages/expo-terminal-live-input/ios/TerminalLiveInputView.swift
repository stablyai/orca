import ExpoModulesCore
import UIKit

private final class RevisionedTerminalTextField: UITextField {
  var onDeleteBackwardAtEmpty: (() -> Void)?

  override func deleteBackward() {
    if (text ?? "").isEmpty {
      onDeleteBackwardAtEmpty?()
    }
    super.deleteBackward()
  }
}

public class TerminalLiveInputView: ExpoView, UITextFieldDelegate {
  let onEditorStateTransaction = EventDispatcher()
  let onInputFocus = EventDispatcher()
  let onInputBlur = EventDispatcher()
  let onKeyPress = EventDispatcher()
  let onTerminalEnter = EventDispatcher()

  private let textField = RevisionedTerminalTextField()
  private var revision = 0
  private var lastSnapshot = EditorSnapshot(text: "", composingStart: nil, composingEnd: nil)
  private var hadMarkedText = false
  private var pendingImeConfirmation = false
  private var imeConfirmationGeneration = 0
  private var isSettingTextProgrammatically = false

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
    textField.text = text
    revision += 1
    lastSnapshot = EditorSnapshot(text: text, composingStart: nil, composingEnd: nil)
    hadMarkedText = false
    clearPendingImeConfirmation()
    isSettingTextProgrammatically = false
  }

  @objc private func handleEditingChanged() {
    if isSettingTextProgrammatically {
      return
    }
    let snapshot = currentSnapshot()
    let hasMarkedText = snapshot.composingStart != nil
    if hadMarkedText && !hasMarkedText {
      armPendingImeConfirmation()
    }
    hadMarkedText = hasMarkedText
    emit(snapshot)
  }

  private func currentSnapshot() -> EditorSnapshot {
    let text = textField.text ?? ""
    guard let markedRange = textField.markedTextRange else {
      return EditorSnapshot(text: text, composingStart: nil, composingEnd: nil)
    }
    let start = textField.offset(from: textField.beginningOfDocument, to: markedRange.start)
    let end = textField.offset(from: textField.beginningOfDocument, to: markedRange.end)
    return EditorSnapshot(text: text, composingStart: start, composingEnd: end)
  }

  private func emit(_ snapshot: EditorSnapshot) {
    if snapshot == lastSnapshot {
      return
    }
    revision += 1
    lastSnapshot = snapshot
    onEditorStateTransaction([
      "revision": revision,
      "text": snapshot.text,
      "composingStart": snapshot.composingStart.map { $0 as Any } ?? NSNull(),
      "composingEnd": snapshot.composingEnd.map { $0 as Any } ?? NSNull()
    ])
  }

  private func armPendingImeConfirmation() {
    imeConfirmationGeneration += 1
    let generation = imeConfirmationGeneration
    pendingImeConfirmation = true
    // Same-run-loop pairing is causal; a later user Enter is never time-window suppressed.
    DispatchQueue.main.async { [weak self] in
      guard let self, self.imeConfirmationGeneration == generation else {
        return
      }
      self.pendingImeConfirmation = false
    }
  }

  private func clearPendingImeConfirmation() {
    imeConfirmationGeneration += 1
    pendingImeConfirmation = false
  }

  public func textFieldDidBeginEditing(_ textField: UITextField) {
    onInputFocus([:])
  }

  public func textFieldDidEndEditing(_ textField: UITextField) {
    onInputBlur([:])
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    if textField.markedTextRange != nil {
      textField.unmarkText()
      emit(currentSnapshot())
      clearPendingImeConfirmation()
      return false
    }
    if pendingImeConfirmation {
      clearPendingImeConfirmation()
      return false
    }
    onTerminalEnter(["revision": revision])
    return false
  }
}

private struct EditorSnapshot: Equatable {
  let text: String
  let composingStart: Int?
  let composingEnd: Int?
}
