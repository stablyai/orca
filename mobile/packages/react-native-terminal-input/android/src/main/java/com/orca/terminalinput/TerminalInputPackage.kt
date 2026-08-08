package com.orca.terminalinput

import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.ViewGroup
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.uimanager.events.Event
import com.facebook.react.views.textinput.ReactEditText
import com.facebook.react.views.textinput.ReactTextInputManager

class TerminalInputPackage : ReactPackage {
  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = listOf(TerminalInputManager())
}

private class TerminalInputManager : ReactTextInputManager() {
  override fun getName(): String = "OrcaTerminalInput"

  override fun createViewInstance(context: ThemedReactContext): ReactEditText {
    val editText = TerminalReactEditText(context)
    editText.inputType = editText.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE.inv()
    editText.returnKeyType = "done"
    editText.layoutParams =
        ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
    return editText
  }

  override fun addEventEmitters(reactContext: ThemedReactContext, editText: ReactEditText) {
    super.addEventEmitters(reactContext, editText)
    val terminalEditText = editText as TerminalReactEditText
    terminalEditText.addTextChangedListener(
        object : TextWatcher {
          override fun beforeTextChanged(text: CharSequence, start: Int, count: Int, after: Int) = Unit

          override fun onTextChanged(text: CharSequence, start: Int, before: Int, count: Int) {
            terminalEditText.dispatchTextChange(text, start, before, count)
          }

          override fun afterTextChanged(text: Editable) = Unit
        }
    )
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> {
    val events = super.getExportedCustomDirectEventTypeConstants().orEmpty().toMutableMap()
    events[TerminalInputEvent.NAME] = mapOf("registrationName" to "onTerminalInput")
    return events
  }
}

private class TerminalReactEditText(
    private val reactContext: ThemedReactContext,
) : ReactEditText(reactContext) {
  private var mutationIsComposing: Boolean? = null

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(outAttrs) ?: return null
    return TerminalInputConnection(connection, this)
  }

  fun dispatchTextChange(text: CharSequence, start: Int, before: Int, count: Int) {
    if (before == 0 && count == 0) return
    if (mutationIsComposing != null) return
    val end = start + count
    if (start < 0 || end < start || end > text.length) return
    dispatch(text.toString(), text.subSequence(start, end).toString(), start, start + before)
  }

  fun mutateInput(
      isComposing: Boolean,
      replacementText: String,
      range: Pair<Int, Int>?,
      mutation: () -> Boolean,
  ): Boolean {
    mutationIsComposing = isComposing
    return try {
      val consumed = mutation()
      if (consumed && range != null) {
        text?.toString()?.let { dispatch(it, replacementText, range.first, range.second) }
      }
      consumed
    } finally {
      mutationIsComposing = null
    }
  }

  fun replacementRange(): Pair<Int, Int>? {
    composingRange()?.let { return it }
    val start = selectionStart
    val end = selectionEnd
    return if (start >= 0 && end >= 0) Pair(minOf(start, end), maxOf(start, end)) else null
  }

  fun composingRange(): Pair<Int, Int>? {
    val currentText = text ?: return null
    val start = BaseInputConnection.getComposingSpanStart(currentText)
    val end = BaseInputConnection.getComposingSpanEnd(currentText)
    return if (start >= 0 && end >= start) Pair(start, end) else null
  }

  fun deletionReplacement(
      beforeLength: Int,
      afterLength: Int,
      inCodePoints: Boolean,
  ): Triple<Int, Int, String>? {
    if (beforeLength < 0 || afterLength < 0) return null
    val currentText = text?.toString() ?: return null
    val orderedSelectionStart = minOf(selectionStart, selectionEnd)
    val orderedSelectionEnd = maxOf(selectionStart, selectionEnd)
    if (orderedSelectionStart < 0 || orderedSelectionEnd > currentText.length) return null
    val composing = composingRange()
    val retainedStart = minOf(orderedSelectionStart, composing?.first ?: orderedSelectionStart)
    val retainedEnd = maxOf(orderedSelectionEnd, composing?.second ?: orderedSelectionEnd)
    val beforeStart =
        if (inCodePoints) {
          val available = Character.codePointCount(currentText, 0, retainedStart)
          Character.offsetByCodePoints(currentText, retainedStart, -minOf(beforeLength, available))
        } else {
          maxOf(0, retainedStart - beforeLength)
        }
    val afterEnd =
        if (inCodePoints) {
          val available = Character.codePointCount(currentText, retainedEnd, currentText.length)
          Character.offsetByCodePoints(currentText, retainedEnd, minOf(afterLength, available))
        } else {
          minOf(currentText.length, retainedEnd + afterLength)
        }
    return Triple(
        beforeStart,
        afterEnd,
        currentText.substring(retainedStart, retainedEnd),
    )
  }

  private fun dispatch(text: String, replacementText: String, start: Int, end: Int) {
    val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id) ?: return
    dispatcher.dispatchEvent(
        TerminalInputEvent(
            UIManagerHelper.getSurfaceId(this),
            id,
            text,
            mutationIsComposing ?: false,
            replacementText,
            start,
            end,
        )
    )
  }
}

private class TerminalInputConnection(
    target: InputConnection,
    private val editText: TerminalReactEditText,
) : InputConnectionWrapper(target, false) {
  override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
    val range = editText.replacementRange()
    val consumed = editText.mutateInput(true, text.toString(), range) {
      super.setComposingText(text, newCursorPosition)
    }
    // Let React Native deliver its synthetic Backspace while the IME still owns it.
    if (text.isEmpty() && consumed) {
      editText.post {
        if (editText.composingRange() == null) editText.mutateInput(false, "", range) { true }
      }
    }
    return consumed
  }

  override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
    return editText.mutateInput(false, text.toString(), editText.replacementRange()) {
      super.commitText(text, newCursorPosition)
    }
  }

  override fun finishComposingText(): Boolean {
    val range = editText.composingRange() ?: return super.finishComposingText()
    val replacementText = editText.text?.subSequence(range.first, range.second)?.toString()
        ?: return super.finishComposingText()
    return editText.mutateInput(false, replacementText, range) { super.finishComposingText() }
  }

  override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
    val replacement = editText.deletionReplacement(beforeLength, afterLength, false)
    return editText.mutateInput(
        editText.composingRange() != null,
        replacement?.third ?: "",
        replacement?.let { Pair(it.first, it.second) },
    ) {
      super.deleteSurroundingText(beforeLength, afterLength)
    }
  }

  override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
    val replacement = editText.deletionReplacement(beforeLength, afterLength, true)
    return editText.mutateInput(
        editText.composingRange() != null,
        replacement?.third ?: "",
        replacement?.let { Pair(it.first, it.second) },
    ) {
      super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    }
  }
}

private class TerminalInputEvent(
    surfaceId: Int,
    viewId: Int,
    private val text: String,
    private val isComposing: Boolean,
    private val replacementText: String,
    private val replacementStart: Int,
    private val replacementEnd: Int,
) : Event<TerminalInputEvent>(surfaceId, viewId) {
  override fun getEventName(): String = NAME

  override fun canCoalesce(): Boolean = false

  override fun getEventData(): WritableMap =
      Arguments.createMap().apply {
        putString("text", text)
        putBoolean("isComposing", isComposing)
        putString("replacementText", replacementText)
        putMap(
            "replacementRange",
            Arguments.createMap().apply {
              putInt("start", replacementStart)
              putInt("end", replacementEnd)
            },
        )
      }

  companion object {
    const val NAME = "topTerminalInput"
  }
}
