/**
 * The four audio verbs: what their schemas refuse, and what the shell's capture answers.
 *
 * The handler is driven through its engine seam rather than through `@orca/expo-two-way-audio`,
 * for the reason the media verbs' device half is driven through one: the arms worth pinning — a
 * denied microphone, a ring that filled, a read after the capture ended — are exactly the ones a
 * simulator makes expensive, and none of them is a fact about Swift.
 */
import { describe, expect, it } from 'vitest'
import { MobileWebBundleRouteSchema } from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES } from '../../hooks/mobile-dictation-pending-audio-budget'
import { BridgeNativeVerbRefusedError } from '../bridge-host-errors'
import { createNativeAudioCapture, type NativeAudioEngine } from '../../platform/native-audio'
import {
  BRIDGE_AUDIO_READ_MAX_BASE64_CHARS,
  BRIDGE_AUDIO_RING_MAX_BYTES,
  audioReadParamsSchema,
  audioReadResultSchema,
  audioStartParamsSchema,
  audioStopParamsSchema,
  audioStopResultSchema
} from './bridge-audio-verbs'
import { BRIDGE_NATIVE_VERB_NAMES, BRIDGE_NATIVE_VERBS } from './bridge-native-verbs'

const AUDIO_VERBS = ['native.audio.start', 'native.audio.read', 'native.audio.stop'] as const

/** An engine whose every call is a value a case can set, and whose events a case can fire. */
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
  /** The screen lock's calls, apart from the engine's own: whether the capture is holding is a
   *  different question from what the engine was asked to do. */
  const screen: string[] = []
  const engine: NativeAudioEngine = {
    requestPermission: overrides.permission ?? (async () => 'granted'),
    open: overrides.open ?? (async (sampleRate) => ({ opened: true, sampleRate })),
    begin: overrides.begin ?? (() => true),
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
    log,
    screen,
    /** How many handlers the engine is still calling. One per live capture, or a leak. */
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

describe('the audio verbs in the table', () => {
  it('lists all three, each under a name a manifest grant may carry', () => {
    for (const verb of AUDIO_VERBS) {
      expect(BRIDGE_NATIVE_VERB_NAMES, verb).toContain(verb)
      expect(BRIDGE_NATIVE_VERBS[verb], verb).toBeDefined()
      // The ruling-6a trap, pinned against the schema itself rather than against a copy of its
      // regex: `native.audio.readChunk` is not a route that falls back to native, it is a bundle
      // the phone refuses entire.
      expect(
        MobileWebBundleRouteSchema.safeParse({ pathname: '/h', grants: [verb] }).success,
        verb
      ).toBe(true)
    }
  })

  it('refuses the camel-cased spelling of the read, which is what makes the name load-bearing', () => {
    expect(
      MobileWebBundleRouteSchema.safeParse({ pathname: '/h', grants: ['native.audio.readChunk'] })
        .success
    ).toBe(false)
  })
})

describe('what the audio schemas refuse', () => {
  it('refuses a start with no rate, a rate off the grid, and an unknown param', () => {
    expect(audioStartParamsSchema.safeParse({}).success).toBe(false)
    expect(audioStartParamsSchema.safeParse({ sampleRate: 16_000.5 }).success).toBe(false)
    expect(audioStartParamsSchema.safeParse({ sampleRate: 96_000 }).success).toBe(false)
    expect(audioStartParamsSchema.safeParse({ sampleRate: 0 }).success).toBe(false)
    expect(audioStartParamsSchema.safeParse({ sampleRate: 16_000, channels: 1 }).success).toBe(
      false
    )
    expect(audioStartParamsSchema.safeParse({ sampleRate: 16_000 }).success).toBe(true)
  })

  it("holds a read to the ring, which is the page's own pending-audio budget", () => {
    expect(BRIDGE_AUDIO_RING_MAX_BYTES).toBe(MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES)
    expect(audioReadParamsSchema.safeParse({ maxBytes: 0 }).success).toBe(false)
    expect(
      audioReadParamsSchema.safeParse({ maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES + 1 }).success
    ).toBe(false)
    expect(audioReadParamsSchema.safeParse({ maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES }).success).toBe(
      true
    )
  })

  it('refuses a stop carrying anything', () => {
    expect(audioStopParamsSchema.safeParse({ why: 'done' }).success).toBe(false)
    expect(audioStopParamsSchema.safeParse({}).success).toBe(true)
  })

  it('declares a base64 field a full drain still fits in', () => {
    expect(BRIDGE_AUDIO_READ_MAX_BASE64_CHARS).toBe(Math.ceil(BRIDGE_AUDIO_RING_MAX_BYTES / 3) * 4)
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
    const { engine, log } = createTestEngine({ permission: async () => 'denied' })
    const capture = createNativeAudioCapture(engine)
    await expect(capture.serve('native.audio.start', { sampleRate: 16_000 })).resolves.toEqual({
      started: false,
      sampleRate: 16_000,
      permission: 'denied'
    })
    // Nothing was opened, so nothing has to be torn down.
    expect(log).toEqual([])
  })

  it('surfaces an engine that would not open on a granted microphone', async () => {
    const { engine } = createTestEngine({
      open: async () => ({ opened: false, sampleRate: 16_000 })
    })
    const capture = createNativeAudioCapture(engine)
    await expect(capture.serve('native.audio.start', { sampleRate: 16_000 })).resolves.toEqual({
      started: false,
      sampleRate: 16_000,
      permission: 'granted'
    })
  })

  it('answers the rate the device opened at, not the one that was asked for', async () => {
    const { engine } = createTestEngine({
      open: async () => ({ opened: true, sampleRate: 48_000 })
    })
    const capture = createNativeAudioCapture(engine)
    await expect(capture.serve('native.audio.start', { sampleRate: 16_000 })).resolves.toEqual({
      started: true,
      sampleRate: 48_000,
      permission: 'granted'
    })
  })

  it('drains what the microphone produced, in order, and reports no drop', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(1_024, 1))
    emit(pcm(1_024, 2))
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(read.droppedBytes).toBe(0)
    expect(read.recording).toBe(true)
    expect(read.interruption).toBeNull()
    expect(Array.from(decode(read.base64))).toEqual([
      ...Array.from(pcm(1_024, 1)),
      ...Array.from(pcm(1_024, 2))
    ])
  })

  it('serves a partial drain from the front and keeps the rest for the next read', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(3_000, 5))
    const first = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: 1_200 })
    )
    const second = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(decode(first.base64).byteLength).toBe(1_200)
    expect(decode(second.base64).byteLength).toBe(1_800)
    expect(Array.from(decode(second.base64))).toEqual(Array.from(pcm(3_000, 5).subarray(1_200)))
  })

  it('rings at the budget and answers what it could not hold', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    // One byte short of the ring, then a chunk that cannot fit: the newcomer is dropped, so what
    // the page drains is still contiguous audio and never a splice of two moments.
    emit(pcm(BRIDGE_AUDIO_RING_MAX_BYTES - 1, 3))
    emit(pcm(64, 4))
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(decode(read.base64).byteLength).toBe(BRIDGE_AUDIO_RING_MAX_BYTES - 1)
    expect(read.droppedBytes).toBe(64)
    // Cleared by the read that reported it: two reads must never count the same dropped byte.
    const next = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(next.droppedBytes).toBe(0)
  })

  it('never holds more than the ring however many chunks arrive', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    for (let index = 0; index < 400; index += 1) {
      emit(pcm(1_024, index))
    }
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(decode(read.base64).byteLength).toBeLessThanOrEqual(BRIDGE_AUDIO_RING_MAX_BYTES)
    expect(decode(read.base64).byteLength + read.droppedBytes).toBe(400 * 1_024)
  })

  it('carries an interruption on the next read and stops reporting it after', async () => {
    const { engine, emit, interrupt } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(256, 9))
    interrupt('began')
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(read.interruption).toBe('began')
    // The capture is gone, but the bytes it produced are still the page's to drain.
    expect(read.recording).toBe(false)
    expect(decode(read.base64).byteLength).toBe(256)
    const next = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(next.interruption).toBeNull()
  })

  it('keeps a capture the OS handed back, and ends the two it took away', async () => {
    const { engine, interrupt } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    interrupt('ended')
    const kept = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    // The kind still crosses — the page is told what happened — but the capture is still live, so
    // the ring goes on filling and the page goes on draining it.
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
    const capture = createNativeAudioCapture(engine)
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
    // A second stop is the state the page already has, not a fault.
    await expect(capture.serve('native.audio.stop', {})).resolves.toEqual({
      stopped: false,
      base64: '',
      droppedBytes: 0
    })
  })

  it('refuses a read before any start', async () => {
    const { engine } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await expect(capture.serve('native.audio.read', { maxBytes: 1_024 })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BridgeNativeVerbRefusedError && error.code === 'native_audio_not_capturing'
    )
  })

  it('takes the microphone off the moment a capture ends', async () => {
    const { engine, emit, log } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    await capture.serve('native.audio.stop', {})
    expect(log).toContain('end')
    expect(log).toContain('microphone-off')
    // A late event from an engine that has not finished shutting down reaches nothing.
    emit(pcm(1_024, 1))
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    expect(read.base64).toBe('')
  })

  it('replaces a capture a page left behind rather than refusing the new one', async () => {
    // The page is a document that can navigate, fault or be swiped away mid-capture, and the shell
    // is the only side that can notice. A second start therefore ends the first.
    const { engine, emit, log } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
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
    // A page can be reloaded while the OS prompt is up — the shell's own reason for replacing a
    // capture rather than refusing one — and both starts then reach `listen()`. The second
    // overwriting the first left the first's handlers subscribed for the app's lifetime, so the
    // engine kept filling a ring nobody could read and `dispose` freed one of two.
    const prompt: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      prompt.release = resolve
    })
    const { engine, log, liveListeners } = createTestEngine({
      permission: async () => {
        await gate
        return 'granted'
      }
    })
    const capture = createNativeAudioCapture(engine)
    const first = capture.serve('native.audio.start', { sampleRate: 16_000 })
    const second = capture.serve('native.audio.start', { sampleRate: 16_000 })
    prompt.release()
    await expect(first).resolves.toMatchObject({ started: true })
    await expect(second).resolves.toMatchObject({ started: true })
    expect(liveListeners()).toEqual({ microphone: 1, interruptions: 1 })
    capture.dispose()
    expect(liveListeners()).toEqual({ microphone: 0, interruptions: 0 })
    // Two captures were opened and both were ended: one by the replacement, one by the dispose.
    expect(log.filter((entry) => entry === 'end')).toHaveLength(2)
  })

  it('does not open a capture for a start that lands after the session ended', async () => {
    const prompt: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      prompt.release = resolve
    })
    const { engine, liveListeners, log } = createTestEngine({
      permission: async () => {
        await gate
        return 'granted'
      }
    })
    const capture = createNativeAudioCapture(engine)
    const pending = capture.serve('native.audio.start', { sampleRate: 16_000 })
    capture.dispose()
    prompt.release()
    await expect(pending).resolves.toMatchObject({ started: false })
    expect(liveListeners()).toEqual({ microphone: 0, interruptions: 0 })
    // And the device is left torn down. The open succeeded — on a phone that is `initialize()`
    // bringing the audio session up — so a start that simply returned here would leave it up with
    // nothing holding it: the local end is a no-op with no capture, and nobody else will call one.
    expect(log).toContain('end')
  })

  it('tears the device down for a start that lost the race after opening', async () => {
    const prompt: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      prompt.release = resolve
    })
    // The race lost after the permission, inside the open itself, which is the longer of the two.
    const { engine, log, liveListeners } = createTestEngine({
      open: async (sampleRate) => {
        await gate
        return { opened: true, sampleRate }
      }
    })
    const capture = createNativeAudioCapture(engine)
    const pending = capture.serve('native.audio.start', { sampleRate: 16_000 })
    capture.dispose()
    prompt.release()
    await expect(pending).resolves.toEqual({
      started: false,
      sampleRate: 16_000,
      permission: 'granted'
    })
    expect(log.filter((entry) => entry === 'end')).toHaveLength(1)
    expect(liveListeners()).toEqual({ microphone: 0, interruptions: 0 })
  })

  it('ends a capture a stop asked for while its start was still opening', async () => {
    const prompt: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      prompt.release = resolve
    })
    const { engine, liveListeners } = createTestEngine({
      permission: async () => {
        await gate
        return 'granted'
      }
    })
    const capture = createNativeAudioCapture(engine)
    const started = capture.serve('native.audio.start', { sampleRate: 16_000 })
    const stopped = capture.serve('native.audio.stop', {})
    prompt.release()
    await started
    // The stop runs after the start it followed, so it ends the capture that start opened rather
    // than finding nothing and leaving a live microphone behind it.
    await expect(stopped).resolves.toEqual({ stopped: true, base64: '', droppedBytes: 0 })
    expect(liveListeners()).toEqual({ microphone: 0, interruptions: 0 })
  })

  it('ends the capture when the page session does', async () => {
    const { engine, log } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
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
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    expect(screen).toEqual(['+'])
    await capture.serve('native.audio.stop', {})
    expect(screen).toEqual(['+', '-'])
  })

  it('gives it back when the page session ends with a capture still open', async () => {
    const { engine, screen } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    capture.dispose()
    expect(screen).toEqual(['+', '-'])
  })

  it('holds nothing for a start the device refused', async () => {
    const { engine, screen } = createTestEngine({ permission: async () => 'denied' })
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    expect(screen).toEqual([])
  })

  it('gives it back when the engine throws after the capture is open', async () => {
    const { engine, screen } = createTestEngine({
      begin: () => {
        throw new Error('the audio engine would not start')
      }
    })
    const capture = createNativeAudioCapture(engine)
    await expect(capture.serve('native.audio.start', { sampleRate: 16_000 })).rejects.toThrow(
      'would not start'
    )
    // The throw leaves no capture behind, so it leaves no screen held either.
    expect(screen).toEqual(['+', '-'])
  })

  it('does not take it twice when a second start replaces the first', async () => {
    const { engine, screen } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    // The replacement ends the first capture and opens its own: one tag out at a time, never two
    // activations the second of which nothing will ever give back.
    expect(screen).toEqual(['+', '-', '+'])
    capture.dispose()
    expect(screen).toEqual(['+', '-', '+', '-'])
  })
})

describe('the tail the stop reply carries', () => {
  it('answers with everything the ring still held', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    const tail = pcm(12_288, 11)
    emit(tail)
    const stopped = audioStopResultSchema.parse(await capture.serve('native.audio.stop', {}))
    expect(stopped.stopped).toBe(true)
    expect(Array.from(decode(stopped.base64))).toEqual(Array.from(tail))
    expect(stopped.droppedBytes).toBe(0)
  })

  it('hands a byte to the read or to the stop, never to both and never to neither', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    const spoken = pcm(2_048, 3)
    emit(spoken)
    const read = audioReadResultSchema.parse(
      await capture.serve('native.audio.read', { maxBytes: BRIDGE_AUDIO_RING_MAX_BYTES })
    )
    // What the microphone produced between that read and the stop, which is the audio no timer is
    // ever coming for.
    const after = pcm(1_024, 7)
    emit(after)
    const stopped = audioStopResultSchema.parse(await capture.serve('native.audio.stop', {}))
    expect(Array.from(decode(read.base64))).toEqual(Array.from(spoken))
    expect(Array.from(decode(stopped.base64))).toEqual(Array.from(after))
  })

  it('carries what the ring refused since the last read', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(BRIDGE_AUDIO_RING_MAX_BYTES))
    emit(pcm(2_048))
    const stopped = audioStopResultSchema.parse(await capture.serve('native.audio.stop', {}))
    expect(stopped.droppedBytes).toBe(2_048)
  })

  it('answers no tail for a session that was not capturing', async () => {
    const { engine } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    const stopped = audioStopResultSchema.parse(await capture.serve('native.audio.stop', {}))
    expect(stopped).toEqual({ stopped: false, base64: '', droppedBytes: 0 })
  })

  it('leaves nothing behind for a second stop to answer with', async () => {
    const { engine, emit } = createTestEngine()
    const capture = createNativeAudioCapture(engine)
    await capture.serve('native.audio.start', { sampleRate: 16_000 })
    emit(pcm(512, 5))
    await capture.serve('native.audio.stop', {})
    const again = audioStopResultSchema.parse(await capture.serve('native.audio.stop', {}))
    expect(again).toEqual({ stopped: false, base64: '', droppedBytes: 0 })
  })

  it('reads a reply from a shell too old to carry a tail', () => {
    // The page updates over the air and the shell does not, so the page parses a stop reply from a
    // build that answers `stopped` alone. It loses that dictation's tail; it must not lose the
    // stop, which is what a required field would have cost.
    expect(audioStopResultSchema.parse({ stopped: true })).toEqual({
      stopped: true,
      base64: '',
      droppedBytes: 0
    })
  })

  it('bounds the tail by the same budget a read is bounded by', () => {
    expect(
      audioStopResultSchema.safeParse({
        stopped: true,
        base64: 'A'.repeat(BRIDGE_AUDIO_READ_MAX_BASE64_CHARS + 1),
        droppedBytes: 0
      }).success
    ).toBe(false)
    expect(
      audioStopResultSchema.safeParse({ stopped: true, base64: 'not base64!', droppedBytes: 0 })
        .success
    ).toBe(false)
  })
})
