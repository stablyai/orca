package expo.modules.orcaterminalkeycapture

import android.view.KeyEvent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalKeyDispatchTrackerTest {
  private val tracker = TerminalKeyDispatchTracker()

  // A hardware keyboard reports a real device id; IME-injected events carry none.
  private val hw = 7
  private val ime = -1

  @Test
  fun aTakenChordConsumesItsMatchingKeyUp() {
    tracker.onChordTaken(KeyEvent.KEYCODE_C, hw)
    assertTrue(tracker.onKeyUp(KeyEvent.KEYCODE_C, hw))
    // Once released, another key-up for it belongs to the field's own press.
    assertFalse(tracker.onKeyUp(KeyEvent.KEYCODE_C, hw))
  }

  @Test
  fun repeatsOfATakenKeyAreConsumedWhilePlainPressesPass() {
    assertFalse(tracker.shouldConsumeRepeat(KeyEvent.KEYCODE_C, hw, repeatCount = 1))
    tracker.onChordTaken(KeyEvent.KEYCODE_C, hw)
    assertFalse(tracker.shouldConsumeRepeat(KeyEvent.KEYCODE_C, hw, repeatCount = 0))
    assertTrue(tracker.shouldConsumeRepeat(KeyEvent.KEYCODE_C, hw, repeatCount = 3))
    // A different key's repeats, and another device's repeats, are their own.
    assertFalse(tracker.shouldConsumeRepeat(KeyEvent.KEYCODE_D, hw, repeatCount = 3))
    assertFalse(tracker.shouldConsumeRepeat(KeyEvent.KEYCODE_C, ime, repeatCount = 3))
  }

  @Test
  fun repeatsStopBeingConsumedAfterTheKeyUp() {
    tracker.onChordTaken(KeyEvent.KEYCODE_C, hw)
    assertTrue(tracker.onKeyUp(KeyEvent.KEYCODE_C, hw))
    assertFalse(tracker.shouldConsumeRepeat(KeyEvent.KEYCODE_C, hw, repeatCount = 2))
  }

  @Test
  fun aKeyUpThatReturnsAfterFocusIsRegainedIsStillConsumed() {
    // The record survives focus loss: a press still held when focus returns finishes here, so
    // its key-up cannot reach the field and hide the keyboard.
    tracker.onChordTaken(KeyEvent.KEYCODE_ENTER, hw)
    assertTrue(tracker.onKeyUp(KeyEvent.KEYCODE_ENTER, hw))
  }

  @Test
  fun aFreshDownRetiresARecordWhoseKeyUpWentToAnotherView() {
    tracker.onChordTaken(KeyEvent.KEYCODE_ENTER, hw)
    // Focus moved while the key was held and the key-up was dispatched there; the record left
    // behind must not swallow this device's next plain press or its repeats.
    tracker.onKeyDown(KeyEvent.KEYCODE_ENTER, hw)
    assertFalse(tracker.shouldConsumeRepeat(KeyEvent.KEYCODE_ENTER, hw, repeatCount = 2))
    assertFalse(tracker.onKeyUp(KeyEvent.KEYCODE_ENTER, hw))
  }

  @Test
  fun eachDeviceHoldingTheSameKeyGetsItsOwnKeyUp() {
    // A hardware Escape held together with an IME-sent Escape: two opens, two key-ups to eat, or
    // the second one falls through to Back.
    tracker.onChordTaken(KeyEvent.KEYCODE_ESCAPE, hw)
    tracker.onChordTaken(KeyEvent.KEYCODE_ESCAPE, ime)
    assertTrue(tracker.onKeyUp(KeyEvent.KEYCODE_ESCAPE, ime))
    assertTrue(tracker.onKeyUp(KeyEvent.KEYCODE_ESCAPE, hw))
  }

  @Test
  fun aKeyUpFromADeviceWhoseDownWasNotTakenPasses() {
    tracker.onChordTaken(KeyEvent.KEYCODE_ENTER, hw)
    // The IME's plain press reached the field, so its key-up must reach it too — swallowing it
    // would leave the field holding a down that never ends.
    assertFalse(tracker.onKeyUp(KeyEvent.KEYCODE_ENTER, ime))
    // The hardware press is still open; its own key-up is still consumed.
    assertTrue(tracker.onKeyUp(KeyEvent.KEYCODE_ENTER, hw))
  }
}
