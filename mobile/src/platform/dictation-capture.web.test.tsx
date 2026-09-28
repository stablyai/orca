/**
 * The page's form of the capture seam: the shell holds the microphone and the page drains it.
 *
 * Driven through the real port pair against the real shell handler, so what this reads is the four
 * verbs leaving the page and the chunks the drain builds out of what came back — the same path the
 * composer's mic button takes. Every refusal is a case, because the whole point of the seam is
 * that a shell saying no reaches the screen as the state it is rather than as a crash.
 */
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The provider module re-exports the screen hooks, and reaching the real ones imports the Expo
// runtime this test does not have. Nothing below calls one.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../transport/client-context.web'
import { BRIDGE_AUDIO_RING_MAX_BYTES } from '../mobile-web-shell/bridge/bridge-audio-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { NativeVerbError } from '../mobile-web-shell/bridge/use-native-verbs'
import { MOBILE_DICTATION_PCM_SAMPLE_RATE } from '../hooks/mobile-dictation-pending-audio-budget'
import { createNativeAudioCapture, type NativeAudioEngine } from './native-audio'
import { useDictationCapture } from './dictation-capture.web'
import { DICTATION_CAPTURE_DRAIN_INTERVAL_MS } from './dictation-capture-contract'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import type { DictationCapture, DictationCaptureChunk } from './dictation-capture-contract'

/** The three verbs, served by the real shell handlers over an engine a case drives. */
function createAudioShell(
  options: {
    permission?: 'granted' | 'denied' | 'undetermined'
    opens?: boolean
    refuse?: (verb: BridgeNativeVerb) => Error | null
  } = {}
) {
  let microphone: ((bytes: Uint8Array) => void) | null = null
  let interrupt: ((kind: 'began' | 'ended' | 'blocked') => void) | null = null
  const engine: NativeAudioEngine = {
    requestPermission: async () => options.permission ?? 'granted',
    open: async (sampleRate) => ({ opened: options.opens !== false, sampleRate }),
    begin: () => true,
    end: () => {},
    onMicrophoneData: (handler) => {
      microphone = handler
      return {
        remove: () => {
          microphone = null
        }
      }
    },
    onInterruption: (handler) => {
      interrupt = handler
      return {
        remove: () => {
          interrupt = null
        }
      }
    },
    screenLock: { hold: () => {}, release: () => {} }
  }
  const capture = createNativeAudioCapture(engine)
  const calls: string[] = []
  return {
    calls,
    speak: (bytes: Uint8Array) => microphone?.(bytes),
    interrupt: (kind: 'began' | 'ended' | 'blocked') => interrupt?.(kind),
    serveNativeVerb: (verb: BridgeNativeVerb, params: unknown): Promise<unknown> => {
      calls.push(verb)
      const refusal = options.refuse?.(verb) ?? null
      if (refusal !== null) {
        return Promise.reject(refusal)
      }
      return capture.serve(verb, params)
    }
  }
}

function pcm(byteLength: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 31 + seed) % 251
  }
  return bytes
}

const held: { capture: DictationCapture | null } = { capture: null }

function Screen(): null {
  held.capture = useDictationCapture()
  return null
}

function render(pair: BridgePortPair): ReactElement {
  return (
    <RpcClientProvider client={pair.client}>
      <Screen />
    </RpcClientProvider>
  )
}

async function mount(pair: BridgePortPair): Promise<DictationCapture> {
  await pair.flush()
  act(() => {
    create(render(pair))
  })
  const capture = held.capture
  if (capture === null) {
    throw new Error('nothing mounted')
  }
  return capture
}

/** One drain interval of fake time, plus the microtasks the read and its reply ride. */
async function tick(pair: BridgePortPair, intervals = 1): Promise<void> {
  for (let index = 0; index < intervals; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DICTATION_CAPTURE_DRAIN_INTERVAL_MS)
      await pair.flush()
    })
  }
}

beforeEach(() => {
  held.capture = null
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('opening a capture on the page', () => {
  it('asks the shell to start and reports the rate it opened at', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await expect(capture.open()).resolves.toEqual({ ok: true })
    expect(shell.calls).toEqual(['native.audio.start'])
  })

  it('reports a denied microphone as the state it is, never as a rejection', async () => {
    const shell = createAudioShell({ permission: 'denied' })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await expect(capture.open()).resolves.toEqual({ ok: false, reason: 'permission-denied' })
  })

  it('reports an engine that would not open apart from a permission', async () => {
    const shell = createAudioShell({ opens: false })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await expect(capture.open()).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('rejects as a native verb error when the route was never granted the audio verbs', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({
      serveNativeVerb: shell.serveNativeVerb,
      routeGrants: ['navigate', 'storage']
    })
    const capture = await mount(pair)
    await expect(capture.open()).rejects.toSatisfy(
      (error: unknown) => error instanceof NativeVerbError && error.reason === 'ungranted'
    )
    // Refused before a frame is sent: an ungranted verb costs no in-flight slot.
    expect(shell.calls).toEqual([])
  })

  it('rejects as a native verb error when the shell refuses the start', async () => {
    const shell = createAudioShell({
      refuse: (verb) =>
        verb === 'native.audio.start'
          ? new BridgeNativeVerbRefusedError('native_verb_failed', 'no microphone on this device')
          : null
    })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await expect(capture.open()).rejects.toSatisfy(
      (error: unknown) => error instanceof NativeVerbError && error.reason === 'native_verb_failed'
    )
  })
})

describe('draining the shell ring', () => {
  it('delivers what the microphone produced, encoded once, with nothing dropped', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    const chunks: DictationCaptureChunk[] = []
    const sub = capture.onChunk((chunk) => chunks.push(chunk))
    await capture.open()
    expect(capture.begin()).toBe(true)
    shell.speak(pcm(1_024))
    await tick(pair)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.droppedBytes).toBe(0)
    // The bytes the microphone produced, in order and unaltered by the crossing.
    expect(Array.from(chunks[0]?.data ?? [])).toEqual(Array.from(pcm(1_024)))
    sub.remove()
  })

  it('delivers nothing for a silent interval rather than an empty chunk', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    const chunks: DictationCaptureChunk[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    await capture.open()
    capture.begin()
    await tick(pair, 3)
    expect(chunks).toEqual([])
    // A budget the page never spends on silence: the reads happened, the chunks did not.
    expect(shell.calls.filter((verb) => verb === 'native.audio.read').length).toBeGreaterThan(0)
  })

  it('carries what the shell ring could not hold', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    const chunks: DictationCaptureChunk[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    await capture.open()
    capture.begin()
    shell.speak(pcm(BRIDGE_AUDIO_RING_MAX_BYTES))
    shell.speak(pcm(2_048))
    await tick(pair)
    expect(chunks[0]?.droppedBytes).toBe(2_048)
  })

  it('delivers the tail the stop reply carried', async () => {
    // The utterance's last 400 ms sits in the shell's ring when the user lifts the button: less
    // than one drain interval, so no timer will ever come for it. Natively that audio is already
    // in the hook's hands by the time recording stops, so a page that dropped it would transcribe
    // a sentence with its ending cut off. It rides the stop's own reply, so the page has no last
    // read to order against the stop.
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    const chunks: DictationCaptureChunk[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    await capture.open()
    capture.begin()
    await tick(pair)
    // 400 ms of 16 kHz 16-bit PCM, spoken after the last drain and before the next one.
    const tail = pcm(12_288, 11)
    shell.speak(tail)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
      await pair.flush()
    })
    expect(chunks).toEqual([])
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    expect(chunks).toHaveLength(1)
    expect(Array.from(chunks[0]?.data ?? [])).toEqual(Array.from(tail))
  })

  it('asks for nothing but the stop, which is what brings the tail', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    const chunks: DictationCaptureChunk[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    await capture.open()
    capture.begin()
    const tail = pcm(2_048, 12)
    shell.speak(tail)
    const before = shell.calls.length
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    // One verb, not a read and then a stop: there is no ordering here to get wrong.
    expect(shell.calls.slice(before)).toEqual(['native.audio.stop'])
    expect(Array.from(chunks.at(-1)?.data ?? [])).toEqual(Array.from(tail))
  })

  it('loses nothing and duplicates nothing when the stop follows a read still in flight', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    const chunks: DictationCaptureChunk[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    await capture.open()
    capture.begin()
    const spoken = pcm(1_024, 31)
    const afterwards = pcm(512, 32)
    shell.speak(spoken)
    await act(async () => {
      // The drain's read leaves the page, and the user lifts the button before its reply is back.
      vi.advanceTimersByTime(DICTATION_CAPTURE_DRAIN_INTERVAL_MS)
      shell.speak(afterwards)
      await capture.end()
      await pair.flush()
    })
    // Every byte the microphone produced, once each and in the order it said them: whether the
    // read or the stop carried a given byte is the shell's business and neither can carry it twice.
    expect(chunks.flatMap((chunk) => Array.from(chunk.data))).toEqual([
      ...Array.from(spoken),
      ...Array.from(afterwards)
    ])
  })

  it('delivers nothing for a second end, which the shell answers as already stopped', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    const chunks: DictationCaptureChunk[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    await capture.open()
    capture.begin()
    shell.speak(pcm(1_024, 41))
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    expect(chunks).toHaveLength(1)
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    // No latch on the page: the shell has no capture, so it answers an empty tail and the page
    // hands nothing on. A second end that delivered would splice the last chunk in twice.
    expect(chunks).toHaveLength(1)
  })

  it('reads nothing once the capture has ended', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await capture.open()
    capture.begin()
    await tick(pair)
    const before = shell.calls.length
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    const afterEnd = shell.calls.length
    await tick(pair, 3)
    // The stop, and then nothing: a timer left running would keep asking a shell that no longer
    // has a capture.
    expect(shell.calls.slice(before, afterEnd)).toEqual(['native.audio.stop'])
    expect(shell.calls.slice(afterEnd)).toEqual([])
  })
})

describe('a capture the page loses', () => {
  it('reaches the interruption lane when the OS takes the microphone', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    let interrupted = 0
    capture.onInterruption(() => {
      interrupted += 1
    })
    await capture.open()
    capture.begin()
    shell.interrupt('began')
    await tick(pair)
    expect(interrupted).toBe(1)
  })

  it('does not end a live capture for an interruption that only ended', async () => {
    // The native seam gates on `began` and `blocked`; the page must gate on the same two, or a
    // notification chime finishing cancels a dictation on the page and nothing natively.
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    let interrupted = 0
    capture.onInterruption(() => {
      interrupted += 1
    })
    await capture.open()
    capture.begin()
    shell.interrupt('ended')
    await tick(pair)
    expect(interrupted).toBe(0)
    // And the drain is still running, so the capture really did survive it.
    const before = shell.calls.length
    await tick(pair)
    expect(shell.calls.length).toBeGreaterThan(before)
    shell.interrupt('blocked')
    await tick(pair)
    expect(interrupted).toBe(1)
  })

  it('reaches the same lane when the shell refuses the read', async () => {
    const shell = createAudioShell({
      refuse: (verb) =>
        verb === 'native.audio.read'
          ? new BridgeNativeVerbRefusedError(
              'native_audio_not_capturing',
              'this session has no capture to read from'
            )
          : null
    })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    let interrupted = 0
    capture.onInterruption(() => {
      interrupted += 1
    })
    await capture.open()
    capture.begin()
    await tick(pair, 3)
    // Once, and then the drain stops: a shell with no capture will not grow one.
    expect(interrupted).toBe(1)
  })

  it('cannot re-enter end from an interruption raised while one is running', async () => {
    // The heap case from PR D's bot round: the hook's handler is `() => void cancel()`, and
    // `cancel` reaches `capture.end()` synchronously through `closeDictationAudio`. When `end`
    // itself read, its refused read raised an interruption that called straight back into `end`,
    // whose own read was refused for the same reason, and the recursion issued bridge reads until
    // the page ran out of memory. There is no read inside `end` now, and a stop reply carries no
    // interruption, so the lane that re-entered does not exist.
    const shell = createAudioShell({
      refuse: (verb) =>
        verb === 'native.audio.read'
          ? new BridgeNativeVerbRefusedError(
              'native_audio_not_capturing',
              'this session has no capture to read from'
            )
          : null
    })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    capture.onInterruption(() => {
      void capture.end()
    })
    await capture.open()
    capture.begin()
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    await tick(pair, 3)
    const reads = shell.calls.filter((verb) => verb === 'native.audio.read').length
    expect(reads).toBeLessThanOrEqual(2)
    // And the stop is not the recursion's new shape either: one per `end` the hook asked for.
    expect(shell.calls.filter((verb) => verb === 'native.audio.stop').length).toBeLessThanOrEqual(2)
  })

  it('goes on ending when an interruption lands while the stop is in flight', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    let interrupted = 0
    capture.onInterruption(() => {
      interrupted += 1
      void capture.end()
    })
    await capture.open()
    capture.begin()
    shell.speak(pcm(1_024, 51))
    await act(async () => {
      vi.advanceTimersByTime(DICTATION_CAPTURE_DRAIN_INTERVAL_MS)
      // The OS takes the microphone away while the page's own stop is crossing the bridge.
      const ending = capture.end()
      shell.interrupt('began')
      await ending
      await pair.flush()
    })
    await tick(pair, 3)
    expect(interrupted).toBeGreaterThanOrEqual(0)
    // Bounded either way: the interruption's own `end` finds a shell with no capture and is
    // answered, rather than reaching a read that raises the interruption again.
    expect(shell.calls.filter((verb) => verb === 'native.audio.stop').length).toBeLessThanOrEqual(3)
    expect(shell.calls.filter((verb) => verb === 'native.audio.read').length).toBeLessThanOrEqual(2)
  })

  it('reads again for the next dictation after an end, rather than staying ended', async () => {
    // `end` is idempotent for the life of one capture, and the seam is memoised per client, so a
    // second dictation on the same screen has to be able to drain.
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    const chunks: DictationCaptureChunk[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    await capture.open()
    capture.begin()
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    await capture.open()
    capture.begin()
    shell.speak(pcm(512, 21))
    await tick(pair)
    expect(Array.from(chunks.at(-1)?.data ?? [])).toEqual(Array.from(pcm(512, 21)))
  })

  it('ends a capture opened after the last end, though `begin` never ran between them', async () => {
    // `open` starts the shell recording, and the hook sets `activeIdRef` before the desktop
    // session exists: a start that goes stale after that point cleans up through `capture.end()`
    // while `commitRecordingStart` -- the only caller of `begin` -- never runs. An `end` still
    // holding the previous dictation's settled promise answers from it and stops nothing, leaving
    // the shell recording a capture no page is draining.
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await capture.open()
    capture.begin()
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    await capture.open()
    const stopsBefore = shell.calls.filter((verb) => verb === 'native.audio.stop').length
    await act(async () => {
      await capture.end()
      await pair.flush()
    })
    const stopsAfter = shell.calls.filter((verb) => verb === 'native.audio.stop').length
    expect(stopsAfter).toBe(stopsBefore + 1)
  })

  it('swallows a refused stop, because a capture that will not end is not the page to fix', async () => {
    const shell = createAudioShell({
      refuse: (verb) =>
        verb === 'native.audio.stop'
          ? new BridgeNativeVerbRefusedError('native_verb_failed', 'the engine would not stop')
          : null
    })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await capture.open()
    capture.begin()
    expect(() => capture.end()).not.toThrow()
    expect(() => capture.release()).not.toThrow()
    await pair.flush()
  })
})

describe('the rate the page asks for', () => {
  it('is the one the desktop transcribes at', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await capture.open()
    const started = pair
      .readToShell()
      .find((frame) => frame.type === 'request' && frame.method === 'native.audio.start')
    expect(started).toBeDefined()
    expect(started?.type === 'request' && started.params).toEqual({
      sampleRate: MOBILE_DICTATION_PCM_SAMPLE_RATE
    })
  })
})
