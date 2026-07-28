package expo.modules.terminalliveinput

import android.content.Context
import android.graphics.Color
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject

class TerminalLiveInputView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  private val onEditorStateTransaction by EventDispatcher()
  private val onInputFocus by EventDispatcher()
  private val onInputBlur by EventDispatcher()
  private val onKeyPress by EventDispatcher()
  private val onTerminalEnter by EventDispatcher()

  private var revision = 0
  private var lastSnapshot = EditorSnapshot("", null, null)
  private var inputConnectionMutationDepth = 0
  private var pendingImeConfirmation = false
  private var imeConfirmationGeneration = 0
  private var terminalEnterDispatchPending = false
  private var isSettingTextProgrammatically = false
  private var activeInputConnection: TerminalLiveInputConnection? = null

  private val editText = object : EditText(context) {
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
      val base = super.onCreateInputConnection(outAttrs) ?: return null
      return TerminalLiveInputConnection(base).also {
        activeInputConnection = it
      }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
      if (keyCode == KeyEvent.KEYCODE_DEL && text.isNullOrEmpty()) {
        onKeyPress(mapOf("key" to "Backspace"))
        return true
      }
      if (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) {
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
    editText.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    editText.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_NONE
    editText.isSingleLine = true
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      editText.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    }
    editText.setOnFocusChangeListener { _, hasFocus ->
      if (hasFocus) onInputFocus(emptyMap()) else onInputBlur(emptyMap())
    }
    editText.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        if (!isSettingTextProgrammatically && inputConnectionMutationDepth == 0) {
          emitCurrentSnapshot()
        }
      }
    })
    editText.setOnEditorActionListener { _, actionId, event ->
      val isEnter =
        actionId == EditorInfo.IME_ACTION_DONE ||
          actionId == EditorInfo.IME_ACTION_GO ||
          actionId == EditorInfo.IME_ACTION_SEND ||
          actionId == EditorInfo.IME_ACTION_NEXT ||
          actionId == EditorInfo.IME_ACTION_NONE ||
          actionId == EditorInfo.IME_ACTION_UNSPECIFIED ||
          event?.keyCode == KeyEvent.KEYCODE_ENTER
      if (!isEnter) false else handleTerminalEnter()
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
    val focused = editText.hasFocus()
    if (focused) {
      val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      manager?.showSoftInput(editText, InputMethodManager.SHOW_IMPLICIT)
    }
    return focused
  }

  fun blurField(): Boolean {
    editText.clearFocus()
    val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    manager?.hideSoftInputFromWindow(editText.windowToken, 0)
    return !editText.hasFocus()
  }

  fun setText(text: String) {
    isSettingTextProgrammatically = true
    editText.clearComposingText()
    editText.setText(text)
    editText.setSelection(text.length.coerceAtMost(editText.text?.length ?: 0))
    revision += 1
    lastSnapshot = EditorSnapshot(text, null, null)
    clearPendingImeConfirmation()
    isSettingTextProgrammatically = false
  }

  private fun handleTerminalEnter(): Boolean {
    if (terminalEnterDispatchPending) {
      return true
    }
    terminalEnterDispatchPending = true
    editText.post { terminalEnterDispatchPending = false }
    if (currentSnapshot().composingStart != null) {
      activeInputConnection?.finishComposingText() ?: editText.clearComposingText()
      clearPendingImeConfirmation()
      emitCurrentSnapshot()
      return true
    }
    if (pendingImeConfirmation) {
      clearPendingImeConfirmation()
      return true
    }
    onTerminalEnter(mapOf("revision" to revision))
    return true
  }

  private fun currentSnapshot(): EditorSnapshot {
    val editable = editText.text
    val text = editable?.toString() ?: ""
    if (editable !is Spanned) {
      return EditorSnapshot(text, null, null)
    }
    val start = BaseInputConnection.getComposingSpanStart(editable)
    val end = BaseInputConnection.getComposingSpanEnd(editable)
    return if (start >= 0 && end >= start) {
      EditorSnapshot(text, start, end)
    } else {
      EditorSnapshot(text, null, null)
    }
  }

  private fun emitCurrentSnapshot() {
    val snapshot = currentSnapshot()
    if (snapshot == lastSnapshot) {
      return
    }
    revision += 1
    lastSnapshot = snapshot
    onEditorStateTransaction(
      mapOf<String, Any>(
        "revision" to revision,
        "text" to snapshot.text,
        "composingStart" to (snapshot.composingStart ?: JSONObject.NULL),
        "composingEnd" to (snapshot.composingEnd ?: JSONObject.NULL)
      )
    )
  }

  private fun armPendingImeConfirmation() {
    imeConfirmationGeneration += 1
    val generation = imeConfirmationGeneration
    pendingImeConfirmation = true
    editText.post {
      if (imeConfirmationGeneration == generation) {
        pendingImeConfirmation = false
      }
    }
  }

  private fun clearPendingImeConfirmation() {
    imeConfirmationGeneration += 1
    pendingImeConfirmation = false
  }

  private inner class TerminalLiveInputConnection(target: InputConnection) :
    InputConnectionWrapper(target, true) {

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean =
      mutateInputConnection {
        super.setComposingText(text, newCursorPosition)
      }

    override fun setComposingRegion(start: Int, end: Int): Boolean =
      mutateInputConnection {
        super.setComposingRegion(start, end)
      }

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
      val wasComposing = currentSnapshot().composingStart != null
      val result = mutateInputConnection {
        super.commitText(text, newCursorPosition)
      }
      if (wasComposing) {
        armPendingImeConfirmation()
      }
      return result
    }

    override fun finishComposingText(): Boolean {
      val wasComposing = currentSnapshot().composingStart != null
      val result = mutateInputConnection {
        super.finishComposingText()
      }
      if (wasComposing) {
        armPendingImeConfirmation()
      }
      return result
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
      if (editText.text.isNullOrEmpty() && beforeLength > 0) {
        onKeyPress(mapOf("key" to "Backspace"))
        return true
      }
      return mutateInputConnection {
        super.deleteSurroundingText(beforeLength, afterLength)
      }
    }

    override fun deleteSurroundingTextInCodePoints(
      beforeLength: Int,
      afterLength: Int
    ): Boolean {
      if (editText.text.isNullOrEmpty() && beforeLength > 0) {
        onKeyPress(mapOf("key" to "Backspace"))
        return true
      }
      return mutateInputConnection {
        super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
      }
    }

    private inline fun mutateInputConnection(mutation: () -> Boolean): Boolean {
      inputConnectionMutationDepth += 1
      return try {
        mutation()
      } finally {
        inputConnectionMutationDepth -= 1
        emitCurrentSnapshot()
      }
    }
  }

  private data class EditorSnapshot(
    val text: String,
    val composingStart: Int?,
    val composingEnd: Int?
  )
}
