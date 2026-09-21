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
import { createNativeWakelockServer } from '../../platform/native-wakelock'
import {
  BRIDGE_AUDIO_READ_MAX_BASE64_CHARS,
  BRIDGE_AUDIO_RING_MAX_BYTES,
  audioReadParamsSchema,
  audioReadResultSchema,
  audioStartParamsSchema,
  audioStopParamsSchema,
  wakelockSetParamsSchema
} from './bridge-audio-verbs'
import { BRIDGE_NATIVE_VERB_NAMES, BRIDGE_NATIVE_VERBS } from './bridge-native-verbs'

const AUDIO_VERBS = [
  'native.audio.start',
  'native.audio.read',
  'native.audio.stop',
  'native.wakelock.set'
] as const

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
  const engine: NativeAudioEngine = {
    requestPermission: overrides.permission ?? (async () => 'granted'),
    open: overrides.open ?? (async (sampleRate) => ({ opened: true, sampleRate })),
    begin: overrides.begin ?? (() => true),
    end: () => {
      log.push('end')
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
  it('lists all four, each under a name a manifest grant may carry', () => {
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

  it('refuses a stop carrying anything and a wakelock with no tag', () => {
    expect(audioStopParamsSchema.safeParse({ why: 'done' }).success).toBe(false)
    expect(audioStopParamsSchema.safeParse({}).success).toBe(true)
    expect(wakelockSetParamsSchema.safeParse({ active: true }).success).toBe(false)
    expect(wakelockSetParamsSchema.safeParse({ active: true, tag: '' }).success).toBe(false)
    expect(wakelockSetParamsSchema.safeParse({ active: true, tag: 'x'.repeat(161) }).success).toBe(
      false
    )
    expect(wakelockSetParamsSchema.safeParse({ active: true, tag: 'orca' }).success).toBe(true)
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
    await expect(capture.serve('native.audio.stop', {})).resolves.toEqual({ stopped: true })
    await expect(capture.serve('native.audio.read', { maxBytes: 1_024 })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BridgeNativeVerbRefusedError && error.code === 'native_audio_not_capturing'
    )
    // A second stop is the state the page already has, not a fault.
    await expect(capture.serve('native.audio.stop', {})).resolves.toEqual({ stopped: false })
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
    await expect(stopped).resolves.toEqual({ stopped: true })
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

describe('the wake lock', () => {
  it('holds a tag, answers what the device did, and gives it back', async () => {
    const held: string[] = []
    const { serve } = createNativeWakelockServer({
      activate: async (tag) => {
        held.push(`+${tag}`)
      },
      deactivate: async (tag) => {
        held.push(`-${tag}`)
      }
    })
    await expect(serve({ active: true, tag: 'orca-a' })).resolves.toEqual({ active: true })
    await expect(serve({ active: false, tag: 'orca-a' })).resolves.toEqual({ active: false })
    expect(held).toEqual(['+orca-a', '-orca-a'])
  })

  it('does not ask the device to drop a tag it never took', async () => {
    const held: string[] = []
    const { serve } = createNativeWakelockServer({
      activate: async (tag) => {
        held.push(`+${tag}`)
      },
      deactivate: async (tag) => {
        held.push(`-${tag}`)
      }
    })
    await expect(serve({ active: false, tag: 'orca-b' })).resolves.toEqual({ active: false })
    expect(held).toEqual([])
  })

  it('reports a tag the device refused as not held', async () => {
    const { serve } = createNativeWakelockServer({
      activate: async () => {
        throw new Error('no keep-awake on this device')
      },
      deactivate: async () => undefined
    })
    await expect(serve({ active: true, tag: 'orca-c' })).rejects.toBeInstanceOf(Error)
  })

  it('keeps a tag recorded when the device refused to drop it, so a retry reaches the device', async () => {
    // The page's owner queues a failed deactivation and retries it (`pendingCleanupTags` in
    // `mobile-dictation-keep-awake.ts`). That retry arrives here as another `active: false`, and it
    // has to reach the device: a shell that had already forgotten the tag answers "not held"
    // without calling anything, and the native tag stays on for the life of the app.
    const calls: string[] = []
    let refuse = true
    const { serve } = createNativeWakelockServer({
      activate: async (tag) => {
        calls.push(`+${tag}`)
      },
      deactivate: async (tag) => {
        calls.push(`-${tag}`)
        if (refuse) {
          throw new Error('the device would not drop the tag')
        }
      }
    })
    await serve({ active: true, tag: 'orca-f' })
    // The refusal crosses, so the page's owner knows to queue a retry rather than believing it.
    await expect(serve({ active: false, tag: 'orca-f' })).rejects.toBeInstanceOf(Error)
    refuse = false
    await expect(serve({ active: false, tag: 'orca-f' })).resolves.toEqual({ active: false })
    expect(calls).toEqual(['+orca-f', '-orca-f', '-orca-f'])
    // And once it is really gone, a third release asks the device nothing.
    await expect(serve({ active: false, tag: 'orca-f' })).resolves.toEqual({ active: false })
    expect(calls).toEqual(['+orca-f', '-orca-f', '-orca-f'])
  })

  it('keeps a tag a dispose could not drop, rather than forgetting it', async () => {
    const calls: string[] = []
    const { serve, dispose } = createNativeWakelockServer({
      activate: async (tag) => {
        calls.push(`+${tag}`)
      },
      deactivate: async (tag) => {
        calls.push(`-${tag}`)
        throw new Error('the device would not drop the tag')
      }
    })
    await serve({ active: true, tag: 'orca-g' })
    dispose()
    await Promise.resolve()
    await Promise.resolve()
    // Still recorded, so the owner's retry is still able to reach the device through this server.
    await expect(serve({ active: false, tag: 'orca-g' })).rejects.toBeInstanceOf(Error)
    expect(calls).toEqual(['+orca-g', '-orca-g', '-orca-g'])
  })

  it('gives back a tag whose activation landed after the session ended', async () => {
    // The page is a document that can be swiped away mid-dictation, so a dispose can fall between
    // the activate call and its reply. A tag recorded after that dispose is held by nobody and
    // keeps the screen awake for the app's lifetime.
    const held: string[] = []
    const gate: { release: () => void } = { release: () => {} }
    const activated = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    const { serve, dispose } = createNativeWakelockServer({
      activate: async (tag) => {
        await activated
        held.push(`+${tag}`)
      },
      deactivate: async (tag) => {
        held.push(`-${tag}`)
      }
    })
    const pending = serve({ active: true, tag: 'orca-late' })
    dispose()
    gate.release()
    // Answered as not held, because by the time the device had it nobody wanted it.
    await expect(pending).resolves.toEqual({ active: false })
    await Promise.resolve()
    expect(held).toEqual(['+orca-late', '-orca-late'])
  })

  it('gives back every tag it still holds when the session ends', async () => {
    const held: string[] = []
    const { serve, dispose } = createNativeWakelockServer({
      activate: async (tag) => {
        held.push(`+${tag}`)
      },
      deactivate: async (tag) => {
        held.push(`-${tag}`)
      }
    })
    await serve({ active: true, tag: 'orca-d' })
    await serve({ active: true, tag: 'orca-e' })
    await serve({ active: false, tag: 'orca-d' })
    dispose()
    await Promise.resolve()
    // Only what was still held: a tag the page already gave back is not deactivated twice.
    expect(held).toEqual(['+orca-d', '+orca-e', '-orca-d', '-orca-e'])
    // And nothing is held afterwards, so a second dispose asks the device nothing.
    dispose()
    await Promise.resolve()
    expect(held).toEqual(['+orca-d', '+orca-e', '-orca-d', '-orca-e'])
  })
})
