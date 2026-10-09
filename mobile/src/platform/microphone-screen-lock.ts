/**
 * The screen lock an open microphone holds, on the device side of whichever capture opened it.
 *
 * A screen that locks mid-capture suspends the app and takes the audio with it, so the lock is a
 * property of the microphone rather than a decision the product makes: the capture that opens the
 * mic takes it and the one that closes it gives it back, and nothing above the seam — the page
 * least of all — names the screen at all.
 */
export type ScreenLockDevice = {
  readonly activate: (tag: string) => Promise<void>
  readonly deactivate: (tag: string) => Promise<void>
}

export type MicrophoneScreenLock = {
  /** Idempotent: a capture that is already holding asks the device nothing. */
  readonly hold: () => void
  /** Idempotent too, and it never deactivates a tag this lock did not take — on an unheld tag that
   *  is a native call with nothing behind it. */
  readonly release: () => void
}

export function createMicrophoneScreenLock(
  device: ScreenLockDevice,
  tag: string
): MicrophoneScreenLock {
  let held = false
  /**
   * The device's calls run in the order they were asked for.
   *
   * Both are async and a capture ends synchronously, so an activate the device is still working on
   * can otherwise settle after the deactivate that followed it — and then the screen is awake with
   * no microphone open and nothing left to turn it off.
   */
  let queue: Promise<unknown> = Promise.resolve()

  function ask(call: () => Promise<void>): void {
    // Quiet: a device that would not hold the screen is not worth failing a dictation for, and a
    // refusal must not wedge the calls queued behind it.
    queue = queue.then(call).catch(() => undefined)
  }

  return {
    hold: () => {
      if (held) {
        return
      }
      held = true
      ask(() => device.activate(tag))
    },
    release: () => {
      if (!held) {
        return
      }
      held = false
      ask(() => device.deactivate(tag))
    }
  }
}
