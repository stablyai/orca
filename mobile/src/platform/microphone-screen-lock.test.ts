// Hold activation open across release to expose the race that leaves a screen awake after capture ends.
import { describe, expect, it } from 'vitest'
import { createMicrophoneScreenLock, type ScreenLockDevice } from './microphone-screen-lock'

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
    // Release before activation settles must still deactivate last.
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
    // Failed wake locks must neither fail dictation nor block queued cleanup.
    expect(calls).toEqual(['+orca-mic', '-orca-mic'])
    lock.hold()
    await flush()
    expect(calls).toEqual(['+orca-mic', '-orca-mic', '+orca-mic'])
  })
})
