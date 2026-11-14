// Exercise table-listed audio verbs through the engine seam; denied permission, full rings and post-stop reads are device-independent conditions expensive to force in simulators.
import { afterEach, describe, expect, it } from 'vitest'

import { BridgeNativeVerbRefusedError } from '../bridge-host-errors'
import {
  createNativeAudioCapture,
  type NativeAudioEngine
} from '../../platform/audio-capture/native-audio'
import {
  BRIDGE_AUDIO_RING_MAX_BYTES,
  audioReadResultSchema,
  audioStopResultSchema
} from './bridge-audio-verbs'

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
    feedSpeech: () => {},
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

describe('the shell capture', () => {
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
})
