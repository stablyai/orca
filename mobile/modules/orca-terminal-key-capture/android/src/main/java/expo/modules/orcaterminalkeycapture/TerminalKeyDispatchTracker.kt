package expo.modules.orcaterminalkeycapture

/**
 * Tracks which key presses the capture view consumed on their way down, per key code and input
 * device. A taken press must keep being consumed — its repeats and its key-up — or the field
 * below sees a press it never took: `ReactEditText` hides the keyboard on Enter's key-up, and a
 * hardware Escape key-up falls back to Back. Two devices can press the same key code at once (a
 * hardware keyboard and an IME injecting events), so records are keyed by device too.
 *
 * Records deliberately survive focus loss: a press still held when focus returns finishes its
 * repeats and key-up here. A record whose key-up was dispatched to whichever view held focus at
 * release instead is retired by that device's next fresh down, so it never shadows a new press.
 */
internal class TerminalKeyDispatchTracker {
  private val pendingUps = mutableMapOf<Int, MutableSet<Int>>()

  /**
   * A fresh down ends this device's previous press of the key whether or not its key-up arrived:
   * an up dispatched to another view leaves a stale record that must not shadow the new press.
   */
  fun onKeyDown(keyCode: Int, deviceId: Int) {
    pendingUps[keyCode]?.remove(deviceId)
    if (pendingUps[keyCode]?.isEmpty() == true) {
      pendingUps.remove(keyCode)
    }
  }

  fun onChordTaken(keyCode: Int, deviceId: Int) {
    pendingUps.getOrPut(keyCode) { mutableSetOf() }.add(deviceId)
  }

  /**
   * A repeat ACTION_DOWN whose original press was taken as a chord must not reach the field:
   * Android keeps the original key-down's modifiers out of repeats once the chord no longer
   * matches, so the field would see a key-down whose key-up is consumed here.
   */
  fun shouldConsumeRepeat(keyCode: Int, deviceId: Int, repeatCount: Int): Boolean =
    repeatCount > 0 && pendingUps[keyCode]?.contains(deviceId) == true

  /**
   * A key-up from a device with a pending press ends its taken down and is swallowed: the field
   * never saw that down, so it must not see the up either. An up from a device with no record
   * pairs with a down the field actually received and must reach it.
   */
  fun onKeyUp(keyCode: Int, deviceId: Int): Boolean {
    val devices = pendingUps[keyCode] ?: return false
    val consumed = devices.remove(deviceId)
    if (devices.isEmpty()) {
      pendingUps.remove(keyCode)
    }
    return consumed
  }

  /** The view is gone; whatever presses were open end with it. */
  fun onReset() {
    pendingUps.clear()
  }
}
