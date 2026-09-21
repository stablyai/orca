/**
 * What one dictation costs the bridge, measured against the cap that actually bounds it.
 *
 * Not the frame cap: a chunk of 500 ms of 16 kHz PCM is 16,000 bytes, which is 21,336 characters of
 * base64 against `BRIDGE_MAX_MESSAGE_BYTES` of 655,360. The bound is
 * `BRIDGE_MAX_PENDING_REQUESTS`, because every `speech.dictation.chunk` is a forwarded request
 * holding a slot for the whole desktop round trip. One request per native microphone event puts
 * Android's 31.25 events a second against a two-second link at 62 of 64 slots — so the page refuses
 * at its own call site before the desktop is even slow.
 *
 * Driven through the real port pair with the real shell handler and a desktop that answers after
 * the link's own delay, so what this counts is frames that were really sent and replies that had
 * really not arrived.
 */
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The provider module re-exports the screen hooks, and reaching the real ones imports the Expo
// runtime this test does not have. Nothing below calls one.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => () => Promise.resolve(),
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../transport/client-context.web'
import { BRIDGE_MAX_PENDING_REQUESTS } from '../mobile-web-shell/bridge/bridge-caps'
import { useNativeVerbs, type NativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { MobileDictationPendingAudioBudget } from '../hooks/mobile-dictation-pending-audio-budget'
import { enqueueMobileDictationAudioChunk } from '../hooks/mobile-dictation-audio-chunk'
import { createNativeAudioCapture, type NativeAudioEngine } from './native-audio'
import { createPageDictationCapture } from './dictation-capture.web'
import {
  DICTATION_CAPTURE_DRAIN_INTERVAL_MS,
  DICTATION_NATIVE_EVENT_INTERVAL_MS
} from './dictation-capture-contract'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'

/** The link the design prices against: a phone on a slow network to a desktop that answers. */
const DESKTOP_ROUND_TRIP_MS = 2_000

/** One dictation long enough to reach a steady state at either rate. */
const SESSION_MS = 10_000

/** 1,024 bytes of 16 kHz 16-bit PCM, which is what both native engines emit per event. */
const NATIVE_EVENT_BYTES = 1_024

function pcm(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 31 + 7) % 251
  }
  return bytes
}

/** A shell holding a real ring over an engine this test speaks into. */
function createAudioShell() {
  let microphone: ((bytes: Uint8Array) => void) | null = null
  const engine: NativeAudioEngine = {
    requestPermission: async () => 'granted',
    open: async (sampleRate) => ({ opened: true, sampleRate }),
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
    onInterruption: () => ({ remove: () => {} })
  }
  const capture = createNativeAudioCapture(engine)
  return {
    speak: (bytes: Uint8Array) => microphone?.(bytes),
    serveNativeVerb: (verb: BridgeNativeVerb, params: unknown): Promise<unknown> =>
      capture.serve(verb, params)
  }
}

/**
 * One dictation of `SESSION_MS`, drained at `drainIntervalMs`, over a link of
 * `DESKTOP_ROUND_TRIP_MS`.
 *
 * The page's half is the two things that decide the cost: the drain, and the chunk each drain
 * forwards. Sampled every native event, so the peak is the real one and not the value at the end.
 */
async function runDictation(
  pair: BridgePortPair,
  shell: ReturnType<typeof createAudioShell>,
  drainIntervalMs: number
): Promise<{
  peakInFlight: number
  chunkRequests: number
  refusals: number
  freeSlots: number
  framesToShell: number
  framesToPage: number
}> {
  const capture = createPageDictationCapture(await mountVerbs(pair), drainIntervalMs)
  const pendingChunks = new Set<Promise<void>>()
  const pendingAudioBudget = new MobileDictationPendingAudioBudget()
  const refusals: string[] = []
  let peakInFlight = 0
  let settled = 0

  capture.onChunk((chunk) => {
    if (chunk.droppedBytes > 0) {
      refusals.push('dropped')
      return
    }
    enqueueMobileDictationAudioChunk(pair.client, 'dictation-1', chunk, {
      pendingChunks,
      pendingAudioBudget,
      shouldReleaseBudget: () => true,
      failActiveDictation: (_id, error) => {
        refusals.push(error instanceof Error ? error.message : String(error))
      }
    })
  })

  await capture.open()
  capture.begin()
  const framesBefore = { toShell: pair.toShell.length, toPage: pair.toPage.length }

  /** The desktop, answering each forwarded chunk one round trip after it arrived. */
  function answerDesktop(): void {
    for (; settled < pair.rpc.requests.length; settled += 1) {
      const request = pair.rpc.requests[settled]
      if (request === undefined) {
        return
      }
      setTimeout(() => request.resolve({ id: 'x', ok: true, result: {} }), DESKTOP_ROUND_TRIP_MS)
    }
  }

  const steps = Math.floor(SESSION_MS / DICTATION_NATIVE_EVENT_INTERVAL_MS)
  for (let step = 0; step < steps; step += 1) {
    shell.speak(pcm(NATIVE_EVENT_BYTES))
    await vi.advanceTimersByTimeAsync(DICTATION_NATIVE_EVENT_INTERVAL_MS)
    await pair.flush()
    answerDesktop()
    peakInFlight = Math.max(peakInFlight, pendingChunks.size)
  }
  const framesToShell = pair.toShell.length - framesBefore.toShell
  const framesToPage = pair.toPage.length - framesBefore.toPage
  const freeSlots = await probeFreeSlots(pair)
  capture.end()
  await pair.flush()
  return {
    peakInFlight,
    freeSlots,
    framesToShell,
    framesToPage,
    chunkRequests: pair.rpc.requests.filter(
      (request) => request.method === 'speech.dictation.chunk'
    ).length,
    refusals: refusals.length
  }
}

/**
 * How much of the in-flight window is left for everything else the page does, at this moment.
 *
 * Ordinary requests are fired until the shell refuses one over the cap, which is the only honest
 * measure of a window: a count of what dictation holds says nothing about what is free unless the
 * cap is the thing that answers.
 */
async function probeFreeSlots(pair: BridgePortPair): Promise<number> {
  let free = 0
  for (let attempt = 0; attempt <= BRIDGE_MAX_PENDING_REQUESTS; attempt += 1) {
    let refused = false
    const pending = pair.client.sendRequest('worktree.list').catch(() => {
      refused = true
    })
    await pair.flush()
    // A request the shell accepted is one the fake desktop is holding, which is a slot spent.
    if (refused) {
      await pending
      return free
    }
    free += 1
  }
  return free
}

const held: { verbs: NativeVerbs | null } = { verbs: null }

function Screen(): null {
  held.verbs = useNativeVerbs()
  return null
}

function render(pair: BridgePortPair): ReactElement {
  return (
    <RpcClientProvider client={pair.client}>
      <Screen />
    </RpcClientProvider>
  )
}

/** The page's own verb surface, taken off a mounted screen exactly as a composer takes it. */
async function mountVerbs(pair: BridgePortPair): Promise<NativeVerbs> {
  await pair.flush()
  act(() => {
    create(render(pair))
  })
  const verbs = held.verbs
  if (verbs === null) {
    throw new Error('nothing mounted')
  }
  return verbs
}

beforeEach(() => {
  held.verbs = null
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('what one dictation spends of the bridge', () => {
  it('fills the in-flight window at one request per native microphone event', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    await pair.flush()
    const spent = await runDictation(pair, shell, DICTATION_NATIVE_EVENT_INTERVAL_MS)
    // 31.25 events a second against a two-second link is 62.5 requests outstanding, which is the
    // whole window. Dictation does not overflow it on its own — it leaves nothing for anything
    // else, which is the same defect one screen later.
    expect(spent.peakInFlight).toBeGreaterThanOrEqual(BRIDGE_MAX_PENDING_REQUESTS - 2)
    expect(spent.freeSlots).toBeLessThanOrEqual(2)
  }, 60_000)

  it('spends four slots of sixty-four on the shipped drain', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    await pair.flush()
    const spent = await runDictation(pair, shell, DICTATION_CAPTURE_DRAIN_INTERVAL_MS)
    // Two chunks a second over a two-second link: four outstanding, and the same 42 KiB/s.
    expect(spent.peakInFlight).toBeLessThanOrEqual(6)
    expect(spent.refusals).toBe(0)
    // The window is still the page's: everything else a screen does still fits.
    expect(spent.freeSlots).toBeGreaterThanOrEqual(BRIDGE_MAX_PENDING_REQUESTS - 8)
    // What ten seconds of dictation costs the bridge, measured: 38 frames out — 19 reads and 19
    // chunk forwards — and 34 back, the four missing being the chunk replies the desktop is still
    // holding at the count. Under four frames a second, each under 4% of the cap, on a transport
    // that moves them inside one process.
    expect({ toShell: spent.framesToShell, toPage: spent.framesToPage }).toEqual({
      toShell: 38,
      toPage: 34
    })
    // Ten seconds at two a second, give or take the drain that lands on the boundary.
    expect(spent.chunkRequests).toBeGreaterThanOrEqual(
      Math.floor(SESSION_MS / DICTATION_CAPTURE_DRAIN_INTERVAL_MS) - 1
    )
    expect(spent.chunkRequests).toBeLessThanOrEqual(
      Math.ceil(SESSION_MS / DICTATION_CAPTURE_DRAIN_INTERVAL_MS) + 1
    )
  }, 60_000)

  it('ships the batched drain, not the native event rate', () => {
    expect(DICTATION_CAPTURE_DRAIN_INTERVAL_MS).toBe(500)
    expect(DICTATION_CAPTURE_DRAIN_INTERVAL_MS).toBeGreaterThan(DICTATION_NATIVE_EVENT_INTERVAL_MS)
  })
})
