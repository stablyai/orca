// Pin the native interruption rule too: began/blocked cancel, while ended alone returns the OS session and must leave dictation alive.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  listeners: new Map<string, (event: { data: unknown }) => void>(),
  calls: new Array<string>(),
  throwOn: new Set<string>(),
  openFails: false,
  // Record queued screen-lock calls separately; their microtask order relative to synchronous engine calls is not a contract.
  screen: new Array<string>(),
  screenTags: new Set<string>()
}))

vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: (name: string, handler: (event: { data: unknown }) => void) => {
    engine.listeners.set(name, handler)
    return {
      remove: () => {
        engine.listeners.delete(name)
      }
    }
  },
  initialize: () => {
    engine.calls.push('initialize')
    return Promise.resolve(!engine.openFails)
  },
  requestMicrophonePermissionsAsync: () => {
    engine.calls.push('permission')
    return Promise.resolve({ granted: true })
  },
  tearDown: () => {
    engine.calls.push('tearDown')
    if (engine.throwOn.has('tearDown')) {
      throw new Error('the audio session would not tear down')
    }
  },
  toggleRecording: (on: boolean) => {
    engine.calls.push(`toggleRecording(${String(on)})`)
    if (engine.throwOn.has(`toggleRecording(${String(on)})`)) {
      throw new Error('the audio engine would not stop')
    }
    return true
  }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: (tag: string) => {
    engine.screen.push('+')
    engine.screenTags.add(tag)
    return Promise.resolve()
  },
  deactivateKeepAwake: (tag: string) => {
    engine.screen.push('-')
    engine.screenTags.add(tag)
    return Promise.resolve()
  }
}))

import { useDictationCapture } from './dictation-capture'

beforeEach(async () => {
  // Release the module-scoped capture lock and drain its queue between cases.
  useDictationCapture().release()
  await flushScreen()
  engine.listeners.clear()
  engine.calls.length = 0
  engine.throwOn.clear()
  engine.openFails = false
  engine.screen.length = 0
  engine.screenTags.clear()
})

async function flushScreen(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('which interruptions end a native capture', () => {
  it('ends on the two the OS means by it, and not on the one it does not', () => {
    const capture = useDictationCapture()
    let interrupted = 0
    capture.onInterruption(() => {
      interrupted += 1
    })
    const fire = (data: string) => engine.listeners.get('onAudioInterruption')?.({ data })
    // Ended returns control after a chime; it must not cancel dictation.
    fire('ended')
    expect(interrupted).toBe(0)
    fire('began')
    expect(interrupted).toBe(1)
    fire('blocked')
    expect(interrupted).toBe(2)
    fire('something-new')
    expect(interrupted).toBe(2)
  })
})

describe('the calls the native half makes', () => {
  it('asks for the permission, opens the engine, and reports what it got', async () => {
    const capture = useDictationCapture()
    await expect(capture.open()).resolves.toEqual({ ok: true })
    expect(engine.calls).toEqual(['permission', 'initialize'])
    expect(capture.begin()).toBe(true)
    await capture.end()
    capture.release()
    expect(engine.calls).toEqual([
      'permission',
      'initialize',
      'toggleRecording(true)',
      'toggleRecording(false)',
      'tearDown'
    ])
  })

  it('hands every microphone event over with nothing dropped', () => {
    const capture = useDictationCapture()
    const chunks: { data: Uint8Array; droppedBytes: number }[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    const bytes = Uint8Array.from([1, 2, 3, 4])
    engine.listeners.get('onMicrophoneData')?.({ data: bytes })
    expect(chunks).toEqual([{ data: bytes, droppedBytes: 0 }])
  })
})

describe('the screen the native microphone holds awake', () => {
  it('takes the screen when the capture opens and gives it back when it closes', async () => {
    const capture = useDictationCapture()
    await capture.open()
    await flushScreen()
    expect(engine.screen).toEqual(['+'])
    await capture.end()
    await flushScreen()
    expect(engine.screen).toEqual(['+', '-'])
    expect(engine.screenTags.size).toBe(1)
  })

  it('gives it back when the screen goes away with a capture still open', async () => {
    const capture = useDictationCapture()
    await capture.open()
    capture.release()
    await flushScreen()
    expect(engine.screen).toEqual(['+', '-'])
  })

  it('holds nothing for an engine that would not open', async () => {
    engine.openFails = true
    const capture = useDictationCapture()
    await expect(useDictationCapture().open()).resolves.toEqual({
      ok: false,
      reason: 'unavailable'
    })
    await flushScreen()
    expect(engine.screen).toEqual([])
    capture.release()
    await flushScreen()
    expect(engine.screen).toEqual([])
  })

  it('does not take it twice when a second open follows the first', async () => {
    const capture = useDictationCapture()
    await capture.open()
    await capture.open()
    await flushScreen()
    expect(engine.screen).toEqual(['+'])
  })
})

describe('a device whose audio session will not shut down', () => {
  it('resolves `end` rather than rejecting it, which the contract promises', async () => {
    // Synchronous try cannot catch void end() rejection; swallow/log binding failures inside cleanup to prevent unhandled rejections.
    engine.throwOn.add('toggleRecording(false)')
    const capture = useDictationCapture()
    await expect(capture.end()).resolves.toBeUndefined()
    expect(engine.calls).toEqual(['toggleRecording(false)'])
  })

  it('does not throw out of `release`, which runs bare in the unmount path', async () => {
    engine.throwOn.add('tearDown')
    const capture = useDictationCapture()
    expect(() => capture.release()).not.toThrow()
    await Promise.resolve()
    expect(engine.calls).toEqual(['tearDown'])
  })

  it('still stops the engine when the tear-down is the half that fails', async () => {
    engine.throwOn.add('tearDown')
    const capture = useDictationCapture()
    await capture.end()
    capture.release()
    await Promise.resolve()
    expect(engine.calls).toEqual(['toggleRecording(false)', 'tearDown'])
  })
})
