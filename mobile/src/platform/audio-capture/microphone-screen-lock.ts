// Keep the screen awake while the mic is open: screen locking suspends capture.
export type ScreenLockDevice = {
  readonly activate: (tag: string) => Promise<void>
  readonly deactivate: (tag: string) => Promise<void>
}

export type MicrophoneScreenLock = {
  readonly hold: () => void
  // Never deactivate an unheld tag; that would be a native call without a matching acquisition.
  readonly release: () => void
}

export function createMicrophoneScreenLock(
  device: ScreenLockDevice,
  tag: string
): MicrophoneScreenLock {
  let held = false
  // Serialize async activation/deactivation so a late activation cannot leave the screen awake after release.
  let queue: Promise<unknown> = Promise.resolve()

  function ask(call: () => Promise<void>): void {
    // Wake-lock failure must neither fail dictation nor block queued cleanup.
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
