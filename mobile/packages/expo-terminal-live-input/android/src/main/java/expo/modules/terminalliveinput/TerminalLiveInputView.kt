package expo.modules.terminalliveinput

import android.content.Context
import android.graphics.Color
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Hosts an EditText that only forwards committed field snapshots to JS.
 * Composing (preedit) updates from the IME never emit terminal text.
 */
class TerminalLiveInputView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  private val onCommittedText by EventDispatcher()
  private val onInputFocus by EventDispatcher()
  private val onInputBlur by EventDispatcher()
  private val onKeyPress by EventDispatcher()
  private val onTerminalEnter by EventDispatcher()

  private var lastEmittedText: String = ""
  private var isComposing: Boolean = false
  private var isSettingTextProgrammatically: Boolean = false
  // Why: IME confirmation often pairs commitText with an editor-action Enter in one turn.
  private var suppressTerminalEnter: Boolean = false
  private var terminalEnterDispatchPending: Boolean = false
  private var activeInputConnection: TerminalLiveInputConnection? = null
  private val clearTerminalEnterSuppressionRunnable = Runnable {
    suppressTerminalEnter = false
  }
  private val clearTerminalEnterDispatchRunnable = Runnable {
    terminalEnterDispatchPending = false
  }

  private val editText = object : EditText(context) {
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
      val base = super.onCreateInputConnection(outAttrs) ?: return null
      return TerminalLiveInputConnection(base).also {
        activeInputConnection = it
      }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
      if (keyCode == KeyEvent.KEYCODE_DEL && (text?.isEmpty() != false)) {
        onKeyPress(mapOf("key" to "Backspace"))
        return true
      }
      if (
        (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) &&
        event.action == KeyEvent.ACTION_DOWN
      ) {
        return handleTerminalEnter()
      }
      return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
      if (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) {
        return true
      }
      return super.onKeyUp(keyCode, event)
    }
  }

  init {
    editText.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    editText.setBackgroundColor(Color.TRANSPARENT)
    // Why: CLASS_TEXT + NO_SUGGESTIONS keeps multilingual IMEs; avoid email/URI variations.
    editText.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    editText.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_NONE
    editText.isSingleLine = true
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      editText.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    }
    editText.setOnFocusChangeListener { _, hasFocus ->
      if (hasFocus) {
        onInputFocus(emptyMap())
      } else {
        onInputBlur(emptyMap())
      }
    }

    editText.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        if (isSettingTextProgrammatically || isComposing) {
          return
        }
        emitCommittedSnapshotIfNeeded()
      }
    })

    editText.setOnEditorActionListener { _, actionId, event ->
      val isEnterAction =
        actionId == EditorInfo.IME_ACTION_DONE ||
          actionId == EditorInfo.IME_ACTION_GO ||
          actionId == EditorInfo.IME_ACTION_SEND ||
          actionId == EditorInfo.IME_ACTION_NEXT ||
          actionId == EditorInfo.IME_ACTION_NONE ||
          actionId == EditorInfo.IME_ACTION_UNSPECIFIED ||
          (
            event != null &&
              event.keyCode == KeyEvent.KEYCODE_ENTER &&
              event.action == KeyEvent.ACTION_DOWN
            )
      if (!isEnterAction) {
        return@setOnEditorActionListener false
      }
      handleTerminalEnter()
    }

    addView(editText)
  }

  fun setEditable(editable: Boolean) {
    editText.isEnabled = editable
    editText.isFocusable = editable
    editText.isFocusableInTouchMode = editable
  }

  fun focusField(): Boolean {
    editText.requestFocus()
    val didFocus = editText.hasFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    if (didFocus) {
      imm?.showSoftInput(editText, InputMethodManager.SHOW_IMPLICIT)
    }
    return didFocus
  }

  fun blurField(): Boolean {
    editText.clearFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(editText.windowToken, 0)
    return !editText.hasFocus()
  }

  fun setText(text: String) {
    isSettingTextProgrammatically = true
    editText.clearComposingText()
    isComposing = false
    clearTerminalEnterSuppression()
    editText.setText(text)
    editText.setSelection(text.length.coerceAtMost(editText.text?.length ?: 0))
    lastEmittedText = text
    isSettingTextProgrammatically = false
  }

  private fun handleTerminalEnter(): Boolean {
    if (terminalEnterDispatchPending) {
      return true
    }
    armTerminalEnterDispatchGuard()
    if (isComposing) {
      // Why: the first Enter confirms the active IME candidate, not the terminal command.
      val finished = activeInputConnection?.finishComposingText() ?: false
      if (!finished) {
        editText.clearComposingText()
        isComposing = false
        armSuppressTerminalEnter()
        emitCommittedSnapshotIfNeeded()
      }
      return true
    }
    if (suppressTerminalEnter) {
      clearTerminalEnterSuppression()
      return true
    }
    onTerminalEnter(mapOf<String, Any>())
    return true
  }

  private fun armTerminalEnterDispatchGuard() {
    editText.removeCallbacks(clearTerminalEnterDispatchRunnable)
    terminalEnterDispatchPending = true
    // Why: some IMEs report one Enter through both key and editor-action callbacks.
    editText.postDelayed(clearTerminalEnterDispatchRunnable, 50L)
  }

  private fun emitCommittedSnapshotIfNeeded() {
    val text = editText.text?.toString() ?: ""
    if (text == lastEmittedText) {
      return
    }
    lastEmittedText = text
    onCommittedText(mapOf("text" to text))
  }

  private fun armSuppressTerminalEnter() {
    editText.removeCallbacks(clearTerminalEnterSuppressionRunnable)
    suppressTerminalEnter = true
    // Why: clear if no Enter/editor-action arrives with this IME commit.
    editText.postDelayed(clearTerminalEnterSuppressionRunnable, 50L)
  }

  private fun clearTerminalEnterSuppression() {
    editText.removeCallbacks(clearTerminalEnterSuppressionRunnable)
    suppressTerminalEnter = false
  }

  private inner class TerminalLiveInputConnection(
    target: InputConnection
  ) : InputConnectionWrapper(target, true) {

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
      isComposing = true
      return super.setComposingText(text, newCursorPosition)
    }

    override fun setComposingRegion(start: Int, end: Int): Boolean {
      val wasComposing = isComposing
      isComposing = start != end
      val result = super.setComposingRegion(start, end)
      if (!isComposing) {
        if (wasComposing) {
          armSuppressTerminalEnter()
        }
        emitCommittedSnapshotIfNeeded()
      }
      return result
    }

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
      val wasComposing = isComposing
      val result = super.commitText(text, newCursorPosition)
      isComposing = false
      // Why: only IME composition-end pairs with confirmation Enter; plain ASCII must not suppress.
      if (wasComposing) {
        armSuppressTerminalEnter()
      }
      emitCommittedSnapshotIfNeeded()
      return result
    }

    override fun finishComposingText(): Boolean {
      val wasComposing = isComposing
      val result = super.finishComposingText()
      isComposing = false
      if (wasComposing) {
        armSuppressTerminalEnter()
      }
      emitCommittedSnapshotIfNeeded()
      return result
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
      val current = editText.text?.toString() ?: ""
      if (current.isEmpty() && beforeLength > 0) {
        onKeyPress(mapOf("key" to "Backspace"))
        return true
      }
      return super.deleteSurroundingText(beforeLength, afterLength)
    }

    override fun deleteSurroundingTextInCodePoints(
      beforeLength: Int,
      afterLength: Int
    ): Boolean {
      val current = editText.text?.toString() ?: ""
      if (current.isEmpty() && beforeLength > 0) {
        onKeyPress(mapOf("key" to "Backspace"))
        return true
      }
      return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    }
  }
}
