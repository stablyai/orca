// Exercise table-listed audio verbs through the engine seam; denied permission, full rings and post-stop reads are device-independent conditions expensive to force in simulators.
import { afterEach, describe, expect, it } from 'vitest'

import { BridgeNativeVerbRefusedError } from '../bridge-host-errors'
import { createNativeAudioCapture, type NativeAudioEngine } from '../../platform/native-audio'
import {
  BRIDGE_AUDIO_READ_MAX_BASE64_CHARS,
  BRIDGE_AUDIO_RING_MAX_BYTES,
  audioReadResultSchema,
  audioStopResultSchema
} from './bridge-audio-verbs'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge-caps'
import { readBridgeHostMessage } from './bridge-envelope'

const captures = new Set<ReturnType<typeof createNativeAudioCapture>>()
function createCapture(engine: NativeAudioEngine) {
  const capture = createNativeAudioCapture(engine)
  captures.add(capture)
  return capture
}
afterEach(() => {
  for (const capture of captures) {
    capture.dispose()
  }
  captures.clear()
})

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release() }
}

function createTestEngine(
  overrides: Partial<{
    permission: NativeAudioEngine['requestPermission']
    open: NativeAudioEngine['open']
    begin: NativeAudioEngine['begin']
  }> = {}
) {
  const microphone: ((bytes: Uint8Array) => void)[] = []
  const interruptions: ((kind: 'began' | 'ended' | 'blocked') => void)[] = []
  const log: string[] = []
  const calls: string[] = []
  const screen: string[] = []
  const engine: NativeAudioEngine = {
    requestPermission: overrides.permission ?? (async () => 'granted'),
    open: (sampleRate) => {
      calls.push('open')
      return overrides.open?.(sampleRate) ?? Promise.resolve({ opened: true, sampleRate })
    },
    begin: () => {
      calls.push('begin')
      return overrides.begin?.() ?? true
    },
    end: () => {
      log.push('end')
    },
    screenLock: {
      hold: () => screen.push('+'),
      release: () => screen.push('-')
    },
    onMicrophoneData: (handler) => {
      microphone.push(handler)
      return {
        remove: () => {
          microphone.splice(microphone.indexOf(handler), 1)
          log.push('microphone-off')
        }
      }
    },
    onInterruption: (handler) => {
      interruptions.push(handler)
      return {
        remove: () => {
          interruptions.splice(interruptions.indexOf(handler), 1)
        }
      }
    }
  }
  return {
    engine,
    calls,
    log,
    screen,
    liveListeners: () => ({ microphone: microphone.length, interruptions: interruptions.length }),
    emit: (bytes: Uint8Array) => {
      for (const handler of microphone) {
        handler(bytes)
      }
    },
    interrupt: (kind: 'began' | 'ended' | 'blocked') => {
      for (const handler of interruptions) {
        handler(kind)
      }
    }
  }
}

function pcm(byteLength: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 31 + seed) % 251
  }
  return bytes
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

describe('what the audio schemas refuse', () => {
  it('accepts a complete full-ring drain within the result and frame caps', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    const bytes = pcm(BRIDGE_AUDIO_RING_MAX_BYTES, 19)
    emit(bytes)
    const result = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(decode(result.base64)).toEqual(bytes)
    const raw = JSON.stringify({
      v: 1,
      type: 'reply',
      id: 'AAAAAAAAAAAAAAAAAAAAAA',
      payload: { id: 'audio', ok: true, result }
    })
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
    expect(readBridgeHostMessage(raw).ok).toBe(true)
    expect(
      audioReadResultSchema.safeParse({
        base64: 'A'.repeat(BRIDGE_AUDIO_READ_MAX_BASE64_CHARS + 1),
        droppedBytes: 0,
        recording: true,
        interruption: null
      }).success
    ).toBe(false)
  })
})

describe('the shell capture', () => {
  it('surfaces a denied microphone as data rather than as a throw', async () => {
    const { engine, calls } = createTestEngine({ permission: async () => 'denied' })
    const capture = createCapture(engine)
    await expect(capture.serve('native.audio.start', { sampleRate: 16_000 })).resolves.toEqual({
      started: false,
      sampleRate: 16_000,
      permission: 'denied'
    })
    expect(calls).toEqual([])
  })

  it('serves a partial drain from the front and keeps the rest for the next read', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(3_000, 5))
    const first = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: 1_200 })
    )
    const second = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(decode(first.base64)).toEqual(pcm(3_000, 5).subarray(0, 1_200))
    expect(decode(second.base64).byteLength).toBe(1_800)
    expect(Array.from(decode(second.base64))).toEqual(Array.from(pcm(3_000, 5).subarray(1_200)))
  })

  it('rings at the budget and answers what it could not hold', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    // Drop the nonfitting newcomer so retained audio stays contiguous rather than splicing two moments.
    emit(pcm(BRIDGE_AUDIO_RING_MAX_BYTES - 1, 3))
    emit(pcm(64, 4))
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(decode(read.base64)).toEqual(pcm(BRIDGE_AUDIO_RING_MAX_BYTES - 1, 3))
    expect(read.droppedBytes).toBe(64)
    const next = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(next.droppedBytes).toBe(0)
  })

  it('carries an interruption on the next read and stops reporting it after', async () => {
    const { engine, emit, interrupt } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(256, 9))
    interrupt('began')
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(read.interruption).toBe('began')
    expect(read.recording).toBe(false)
    expect(decode(read.base64)).toEqual(pcm(256, 9))
    const next = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(next.interruption).toBeNull()
  })

  it('keeps a capture the OS handed back, and ends the two it took away', async () => {
    const { engine, interrupt } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    interrupt('ended')
    const kept = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    // Nonterminal interruption still reaches the page while the live capture keeps filling its ring.
    expect(kept.interruption).toBe('ended')
    expect(kept.recording).toBe(true)
    interrupt('blocked')
    const lost = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(lost.recording).toBe(false)
  })

  it('refuses a read once the page has stopped', async () => {
    const { engine } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    await expect(capture.serve('native.audio.stop', {})).resolves.toEqual({
      stopped: true,
      base64: '',
      droppedBytes: 0
    })
    await expect(capture.serve('native.audio.read', { maxBytes: 1_024 })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BridgeNativeVerbRefusedError && error.code === 'native_audio_not_capturing'
    )
    await expect(capture.serve('native.audio.stop', {})).resolves.toEqual({
      stopped: false,
      base64: '',
      droppedBytes: 0
    })
  })

  it('takes the microphone off the moment a capture ends', async () => {
    const { engine, emit, log } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    await capture.serve('native.audio.stop', {})
    expect(log).toContain('end')
    expect(log).toContain('microphone-off')
    emit(pcm(1_024, 1))
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(read.base64).toBe('')
  })

  it('replaces a capture a page left behind rather than refusing the new one', async () => {
    // A page can reload or vanish mid-capture; only the shell sees that lifecycle, so a new start replaces the old capture.
    const { engine, emit, log } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(2_048, 6))
    await expect(capture.serve('native.audio.start', { sampleRate: 16_000 })).resolves.toEqual({
      started: true,
      sampleRate: 16_000,
      permission: 'granted'
    })
    expect(log.filter((entry) => entry === 'end')).toHaveLength(1)
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(read.base64).toBe('')
  })

  it('leaves one capture behind when two starts race the permission prompt', async () => {
    // Concurrent starts can both leave the OS prompt and reach listen; replacement must remove the earlier handlers rather than leak a ring nobody drains.
    const entered = gate()
    const blocked = gate()
    const { engine, log, liveListeners } = createTestEngine({
      permission: async () => {
        entered.release()
        await blocked.promise
        return 'granted'
      }
    })
    const capture = createCapture(engine)
    const first = capture.serve('native.audio.start', { sampleRate: 16_000 })
    await entered.promise
    const second = capture.serve('native.audio.start', { sampleRate: 16_000 })
    blocked.release()
    await expect(first).resolves.toMatchObject({ started: true })
    await expect(second).resolves.toMatchObject({ started: true })
    expect(liveListeners()).toEqual({ microphone: 1, interruptions: 1 })
    capture.dispose()
    expect(liveListeners()).toEqual({ microphone: 0, interruptions: 0 })
    expect(log.filter((entry) => entry === 'end')).toHaveLength(2)
  })

  it('does not open a capture for a start that lands after the session ended', async () => {
    const entered = gate()
    const blocked = gate()
    const { engine, liveListeners, log, calls } = createTestEngine({
      permission: async () => {
        entered.release()
        await blocked.promise
        return 'granted'
      }
    })
    const capture = createCapture(engine)
    const pending = capture.serve('native.audio.start', { sampleRate: 16_000 })
    await entered.promise
    capture.dispose()
    blocked.release()
    await expect(pending).resolves.toMatchObject({ started: false })
    expect(liveListeners()).toEqual({ microphone: 0, interruptions: 0 })
    expect(calls).toEqual([])
    expect(log).not.toContain('end')
  })

  it('tears the device down for a start that lost the race after opening', async () => {
    const entered = gate()
    const blocked = gate()
    const { engine, log, liveListeners } = createTestEngine({
      open: async (sampleRate) => {
        entered.release()
        await blocked.promise
        return { opened: true, sampleRate }
      }
    })
    const capture = createCapture(engine)
    const pending = capture.serve('native.audio.start', { sampleRate: 16_000 })
    await entered.promise
    capture.dispose()
    blocked.release()
    await expect(pending).resolves.toEqual({
      started: false,
      sampleRate: 16_000,
      permission: 'granted'
    })
    expect(log.filter((entry) => entry === 'end')).toHaveLength(1)
    expect(liveListeners()).toEqual({ microphone: 0, interruptions: 0 })
  })

  it('ends a capture a stop asked for while its start was still opening', async () => {
    const entered = gate()
    const blocked = gate()
    const { engine, liveListeners } = createTestEngine({
      permission: async () => {
        entered.release()
        await blocked.promise
        return 'granted'
      }
    })
    const capture = createCapture(engine)
    const started = capture.serve('native.audio.start', { sampleRate: 16_000 })
    await entered.promise
    const stopped = capture.serve('native.audio.stop', {})
    blocked.release()
    await started
    // Serialize stop after pending start so it closes the resulting microphone instead of observing no capture and leaving one live.
    await expect(stopped).resolves.toEqual({ stopped: true, base64: '', droppedBytes: 0 })
    expect(liveListeners()).toEqual({ microphone: 0, interruptions: 0 })
  })

  it('ends the capture when the page session does', async () => {
    const { engine, log } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    capture.dispose()
    expect(log).toContain('end')
    await expect(capture.serve('native.audio.read', { maxBytes: 16 })).rejects.toBeInstanceOf(
      BridgeNativeVerbRefusedError
    )
  })
})

describe('the screen the shell holds awake while it is capturing', () => {
  it('takes the screen on a start and gives it back on a stop', async () => {
    const { engine, screen } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    expect(screen).toEqual(['+'])
    await capture.serve('native.audio.stop', {})
    expect(screen).toEqual(['+', '-'])
  })

  it('gives it back when the page session ends with a capture still open', async () => {
    const { engine, screen } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    capture.dispose()
    expect(screen).toEqual(['+', '-'])
  })

  it('gives it back when the engine throws after the capture is open', async () => {
    const { engine, screen } = createTestEngine({
      begin: () => {
        throw new Error('the audio engine would not start')
      }
    })
    const capture = createCapture(engine)
    await expect(capture.serve('native.audio.start', { sampleRate: 16_000 })).rejects.toThrow(
      'would not start'
    )
    expect(screen).toEqual(['+', '-'])
  })

  it('does not take it twice when a second start replaces the first', async () => {
    const { engine, screen } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    // Replace the old capture’s wake tag before activating another; never hold two with only one future release.
    expect(screen).toEqual(['+', '-', '+'])
    capture.dispose()
    expect(screen).toEqual(['+', '-', '+', '-'])
  })
})

describe('the tail the stop reply carries', () => {
  it('hands a byte to the read or to the stop, never to both and never to neither', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    const spoken = pcm(2_048, 3)
    emit(spoken)
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    const after = pcm(1_024, 7)
    emit(after)
    const stopped = audioStopResultSchema.parse(await capture.serve('native.audio.stop', {}))
    expect(Array.from(decode(read.base64))).toEqual(Array.from(spoken))
    expect(Array.from(decode(stopped.base64))).toEqual(Array.from(after))
  })

  it('leaves nothing behind for a second stop to answer with', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(512, 5))
    await capture.serve('native.audio.stop', {})
    const again = audioStopResultSchema.parse(await capture.serve('native.audio.stop', {}))
    expect(again).toEqual({ stopped: false, base64: '', droppedBytes: 0 })
  })
})
