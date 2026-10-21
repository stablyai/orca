/**
 * The screen lock a live microphone holds: one tag, taken once, given back once, in order.
 *
 * Driven against a device of its own rather than through a capture, because the arm that matters
 * is the one neither capture can stage — an activate the device is still working on when the
 * release is asked for. Ordered wrongly that activate lands last and the screen stays awake for
 * the life of the app, which is the failure the deleted tag bookkeeping existed to time out.
 */
import { describe, expect, it } from 'vitest'
import { createMicrophoneScreenLock, type ScreenLockDevice } from './microphone-screen-lock'

/** A device whose calls a case can hold open and settle when it chooses. */
function createTestDevice() {
  const calls: string[] = []
  const settles: (() => void)[] = []
  let holdOpen = false
  const answer = (name: string): Promise<void> => {
    calls.push(name)
    if (!holdOpen) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => settles.push(resolve))
  }
  const device: ScreenLockDevice = {
    activate: (tag) => answer(`+${tag}`),
    deactivate: (tag) => answer(`-${tag}`)
  }
  return {
    device,
    calls,
    holdCallsOpen: () => {
      holdOpen = true
    },
    settleAll: () => {
      holdOpen = false
      for (const settle of settles.splice(0)) {
        settle()
      }
    }
  }
}

/** The queue is microtasks; a case reads the device after they have run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the lock a microphone holds', () => {
  it('takes the tag once and gives it back once', async () => {
    const { device, calls } = createTestDevice()
    const lock = createMicrophoneScreenLock(device, 'orca-mic')
    lock.hold()
    lock.release()
    await flush()
    expect(calls).toEqual(['+orca-mic', '-orca-mic'])
  })

  it('asks the device nothing for a hold it already has', async () => {
    const { device, calls } = createTestDevice()
    const lock = createMicrophoneScreenLock(device, 'orca-mic')
    lock.hold()
    lock.hold()
    await flush()
    expect(calls).toEqual(['+orca-mic'])
  })

  it('asks the device nothing for a release of a tag it never took', async () => {
    const { device, calls } = createTestDevice()
    const lock = createMicrophoneScreenLock(device, 'orca-mic')
    lock.release()
    await flush()
    expect(calls).toEqual([])
    // And deactivating an unheld tag is a native call this never makes, so a release after a
    // release asks for nothing either.
    lock.hold()
    lock.release()
    lock.release()
    await flush()
    expect(calls).toEqual(['+orca-mic', '-orca-mic'])
  })

  it('never lets a slow activate land after the release that followed it', async () => {
    const { device, calls, holdCallsOpen, settleAll } = createTestDevice()
    const lock = createMicrophoneScreenLock(device, 'orca-mic')
    holdCallsOpen()
    lock.hold()
    await flush()
    // The release is asked for while the activate is still in flight. Unordered, the deactivate
    // would reach a device holding nothing and the activate would land behind it.
    lock.release()
    await flush()
    expect(calls).toEqual(['+orca-mic'])
    settleAll()
    await flush()
    expect(calls).toEqual(['+orca-mic', '-orca-mic'])
  })

  it('keeps working after a call the device refused', async () => {
    const calls: string[] = []
    const device: ScreenLockDevice = {
      activate: (tag) => {
        calls.push(`+${tag}`)
        return Promise.reject(new Error('no current activity'))
      },
      deactivate: (tag) => {
        calls.push(`-${tag}`)
        return Promise.resolve()
      }
    }
    const lock = createMicrophoneScreenLock(device, 'orca-mic')
    lock.hold()
    lock.release()
    await flush()
    // The refusal is swallowed — a screen that would not stay awake is not worth failing a
    // dictation over — and it does not wedge the calls behind it.
    expect(calls).toEqual(['+orca-mic', '-orca-mic'])
    lock.hold()
    await flush()
    expect(calls).toEqual(['+orca-mic', '-orca-mic', '+orca-mic'])
  })
})
