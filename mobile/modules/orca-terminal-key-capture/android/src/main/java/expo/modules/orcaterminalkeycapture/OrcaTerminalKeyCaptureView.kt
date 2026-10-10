package expo.modules.orcaterminalkeycapture

import android.content.Context
import android.view.KeyCharacterMap
import android.view.KeyEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Wraps the terminal's hidden TextInput on the focus path. React Native's TextInput reports no key
 * event with modifiers, so a Ctrl chord that an IME sends through `InputConnection.sendKeyEvent`
 * (Unexpected Keyboard does) or that a hardware keyboard sends would reach TextView, which drops
 * it or runs a copy/paste shortcut. Key dispatch reaches this view before TextView and before
 * shortcut dispatch.
 */
class OrcaTerminalKeyCaptureView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {
  private val onTerminalKey by EventDispatcher<Map<String, Any>>()

  private val dispatchTracker = TerminalKeyDispatchTracker()

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    when (event.action) {
      KeyEvent.ACTION_DOWN -> {
        // Why: a press still open when this view lost focus may have sent its key-up to the view
        // that took it; the next fresh down on this device retires that leftover record.
        if (event.repeatCount == 0) {
          dispatchTracker.onKeyDown(event.keyCode, event.deviceId)
        }
        val chord = readChord(event)
        if (chord != null) {
          dispatchTracker.onChordTaken(event.keyCode, event.deviceId)
          onTerminalKey(chord.toPayload())
          return true
        }
        // Why: releasing the modifier while still holding the key makes Android send repeat
        // ACTION_DOWNs the chord no longer matches; the field would see a key-down whose key-up
        // is consumed below. Chord repeats still reach readChord first and resend normally.
        if (dispatchTracker.shouldConsumeRepeat(
            event.keyCode,
            event.deviceId,
            event.repeatCount
          )
        ) {
          return true
        }
      }
      KeyEvent.ACTION_UP -> if (dispatchTracker.onKeyUp(event.keyCode, event.deviceId)) return true
    }
    return super.dispatchKeyEvent(event)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    // A down taken for a view that is leaving never gets its key-up dispatched here.
    dispatchTracker.onReset()
  }

  private fun readChord(event: KeyEvent): TerminalKeyChord? {
    if (KeyEvent.isModifierKey(event.keyCode)) {
      return null
    }
    val chordModifiers = KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK or KeyEvent.META_META_MASK
    val altGr = (event.metaState and KeyEvent.META_ALT_RIGHT_ON) != 0
    return TerminalKeyChord.from(
      keyCode = event.keyCode,
      baseChar = event.getUnicodeChar(event.metaState and chordModifiers.inv()) and
        KeyCharacterMap.COMBINING_ACCENT_MASK,
      altGrChar = if (altGr) {
        event.getUnicodeChar(event.metaState) and KeyCharacterMap.COMBINING_ACCENT_MASK
      } else {
        0
      },
      ctrl = event.isCtrlPressed,
      alt = event.isAltPressed,
      shift = event.isShiftPressed,
      meta = event.isMetaPressed
    )
  }
}
