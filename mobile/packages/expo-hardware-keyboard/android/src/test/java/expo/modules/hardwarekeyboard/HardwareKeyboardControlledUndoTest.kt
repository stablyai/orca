package expo.modules.hardwarekeyboard

import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.Editable
import android.text.TextWatcher
import android.text.Layout
import android.text.NoCopySpan
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import com.facebook.react.bridge.NativeModule
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.text.ReactTextUpdate
import com.facebook.react.views.textinput.ReactEditText
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class HardwareKeyboardControlledUndoTest {
  private fun reactTagSpan(tag: Int): Any = Class.forName(
    "com.facebook.react.views.text.internal.span.ReactTagSpan"
  ).getConstructor(Int::class.javaPrimitiveType).newInstance(tag)

  private fun reactInput(): ReactEditText {
    val application = RuntimeEnvironment.getApplication()
    val reactContext = object : HardwareKeyboardRecordingContext(application) {
      override fun getNativeModules(): MutableCollection<NativeModule> = mutableListOf()
    }
    val context = ThemedReactContext(reactContext, application, "test", 1)
    DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
    return ReactEditText(context)
  }

  private fun edit(input: EditText) {
    input.setText("paste-한글\nline-2")
    input.setSelection(input.length() - 1)
    input.beginBatchEdit()
    input.text!!.insert(input.selectionStart, "x")
    input.endBatchEdit()
    assertEquals("paste-한글\nline-x2", input.text.toString())
  }

  private fun undo(input: EditText): Boolean = input.onKeyShortcut(
    KeyEvent.KEYCODE_Z,
    KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_Z, 0, KeyEvent.META_CTRL_ON)
  )

  @Test fun platformEditTextCanUndoNativeInsertion() {
    val input = EditText(RuntimeEnvironment.getApplication())
    edit(input)
    assertTrue(undo(input))
    assertEquals("paste-한글\nline-2", input.text.toString())
  }

  @Test fun reactEditTextCanUndoNativeInsertionWithoutControlledEcho() {
    val input = reactInput()
    edit(input)
    assertTrue(undo(input))
    assertEquals("paste-한글\nline-2", input.text.toString())
  }

  @Test fun identicalControlledEchoPreservesFirstUndo() {
    val input = reactInput()
    edit(input)
    input.maybeSetTextFromJS(ReactTextUpdate(
      SpannableStringBuilder(input.text), input.incrementAndGetEventCounter(), false,
      input.gravity, input.breakStrategy, input.justificationMode
    ))
    assertTrue(undo(input))
    assertEquals("paste-한글\nline-2", input.text.toString())
  }

  @Test fun identicalFabricStateEchoPreservesFirstUndo() {
    val input = reactInput()
    edit(input)
    input.maybeSetTextFromState(ReactTextUpdate(
      SpannableStringBuilder(input.text), input.incrementAndGetEventCounter(), false,
      input.gravity, input.breakStrategy, input.justificationMode
    ))
    assertTrue(undo(input))
    assertEquals("paste-한글\nline-2", input.text.toString())
  }

  private fun update(input: ReactEditText, value: SpannableStringBuilder,
    count: Int = input.incrementAndGetEventCounter(), strategy: Int = input.breakStrategy) =
    ReactTextUpdate(value, count, false, input.gravity, strategy, input.justificationMode)

  @Test fun repeatedEchoesPreserveUndoAndRedo() {
    val input = reactInput()
    edit(input)
    repeat(3) {
      input.maybeSetTextFromState(update(input, SpannableStringBuilder(input.text)))
      input.maybeSetTextFromJS(update(input, SpannableStringBuilder(input.text)))
    }
    assertTrue(undo(input))
    assertEquals("paste-한글\nline-2", input.text.toString())
    assertTrue(input.onKeyShortcut(KeyEvent.KEYCODE_Z, KeyEvent(
      0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_Z, 0,
      KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
    )))
    assertEquals("paste-한글\nline-x2", input.text.toString())
  }

  @Test fun sameTextReconcilesReactSpansAndPreservesCompositionSelectionAndWatchers() {
    val input = reactInput()
    edit(input)
    val editable = input.text!!
    val oldStyle = reactTagSpan(1)
    editable.setSpan(oldStyle, 0, 3, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
    BaseInputConnection.setComposingSpans(editable)
    input.setSelection(1, 4)
    var changes = 0
    val watcher = object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) {
        changes++
      }
      override fun afterTextChanged(s: Editable) = Unit
    }
    input.addTextChangedListener(watcher)
    val newStyle = reactTagSpan(2)
    val incoming = SpannableStringBuilder(editable.toString()).apply {
      setSpan(newStyle, 2, 5, Spanned.SPAN_EXCLUSIVE_INCLUSIVE)
    }
    input.maybeSetTextFromState(update(input, incoming, strategy = Layout.BREAK_STRATEGY_SIMPLE))
    assertSame(editable, input.text)
    assertEquals(-1, editable.getSpanStart(oldStyle))
    assertEquals(2, editable.getSpanStart(newStyle))
    assertEquals(5, editable.getSpanEnd(newStyle))
    assertEquals(Spanned.SPAN_EXCLUSIVE_INCLUSIVE, editable.getSpanFlags(newStyle))
    assertEquals(0, BaseInputConnection.getComposingSpanStart(editable))
    assertEquals(editable.length, BaseInputConnection.getComposingSpanEnd(editable))
    assertEquals(1, input.selectionStart)
    assertEquals(4, input.selectionEnd)
    assertEquals(Layout.BREAK_STRATEGY_SIMPLE, input.breakStrategy)
    assertEquals(0, changes)
    editable.insert(0, "y")
    assertTrue(changes > 0)
    assertEquals(nativeInsertionNotificationsWithoutEcho(), changes)
  }

  @Test fun staleUpdateCannotChangeTextSpansOrBreakStrategy() {
    val input = reactInput()
    edit(input)
    val count = input.incrementAndGetEventCounter()
    val style = reactTagSpan(3)
    val incoming = SpannableStringBuilder(input.text.toString()).apply {
      setSpan(style, 0, 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    val originalStrategy = input.breakStrategy
    input.maybeSetTextFromState(update(input, incoming, count - 1, Layout.BREAK_STRATEGY_BALANCED))
    assertEquals(-1, input.text!!.getSpanStart(style))
    assertEquals(originalStrategy, input.breakStrategy)
    input.maybeSetTextFromJS(update(input, SpannableStringBuilder("stale"), count - 1))
    assertEquals("paste-한글\nline-x2", input.text.toString())
  }

  private fun nativeInsertionNotificationsWithoutEcho(): Int {
    val input = reactInput()
    edit(input)
    val editable = input.text!!
    editable.setSpan(reactTagSpan(1), 0, 3, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
    BaseInputConnection.setComposingSpans(editable)
    input.setSelection(1, 4)
    var changes = 0
    input.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) { changes++ }
      override fun afterTextChanged(s: Editable) = Unit
    })
    editable.insert(0, "y")
    return changes
  }

  @Test fun sameTextDoesNotImportForeignNoCopySpansOrLoseExistingNativeSpans() {
    val input = reactInput()
    edit(input)
    val nativeSpan = NoCopySpan.Concrete()
    val foreignSpan = NoCopySpan.Concrete()
    val stableSpan = Any()
    input.text!!.setSpan(nativeSpan, 1, 3, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    input.text!!.setSpan(stableSpan, 2, 4, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
    val incoming = SpannableStringBuilder(input.text.toString()).apply {
      setSpan(foreignSpan, 0, 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      setSpan(stableSpan, 0, length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
    }
    input.maybeSetTextFromState(update(input, incoming))
    assertEquals(-1, input.text!!.getSpanStart(foreignSpan))
    assertEquals(1, input.text!!.getSpanStart(nativeSpan))
    assertEquals(3, input.text!!.getSpanEnd(nativeSpan))
    assertEquals(2, input.text!!.getSpanStart(stableSpan))
    assertEquals(4, input.text!!.getSpanEnd(stableSpan))
  }

  @Test fun changedTextStillReplacesAndEmptyTextStillClearsComposition() {
    val input = reactInput()
    edit(input)
    input.maybeSetTextFromJS(update(input, SpannableStringBuilder("replacement")))
    assertEquals("replacement", input.text.toString())
    BaseInputConnection.setComposingSpans(input.text!!)
    input.maybeSetTextFromState(update(input, SpannableStringBuilder("")))
    assertEquals("", input.text.toString())
    assertEquals(-1, BaseInputConnection.getComposingSpanStart(input.text!!))
  }
}
