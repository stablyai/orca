// Measure actual request slots through real shell lanes: per-event forwarding nearly fills 64 slots on a two-second link, while batched reads preserve room for other work.
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub re-exported hooks to avoid Expo imports; these tests call none of them.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
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

const DESKTOP_ROUND_TRIP_MS = 2_000

const SESSION_MS = 10_000

const NATIVE_EVENT_BYTES = 1_024

function pcm(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 31 + 7) % 251
  }
  return bytes
}

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
    onInterruption: () => ({ remove: () => {} }),
    screenLock: { hold: () => {}, release: () => {} }
  }
  const capture = createNativeAudioCapture(engine)
  return {
    speak: (bytes: Uint8Array) => microphone?.(bytes),
    serveNativeVerb: (verb: BridgeNativeVerb, params: unknown): Promise<unknown> =>
      capture.serve(verb, params)
  }
}

// Sample free slots at every native event so the peak reflects read/forward costs, not merely the final outstanding count.
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

// Fill the remaining window until refusal; dictation’s own count alone cannot prove how much capacity others retain.
async function probeFreeSlots(pair: BridgePortPair): Promise<number> {
  let free = 0
  for (let attempt = 0; attempt <= BRIDGE_MAX_PENDING_REQUESTS; attempt += 1) {
    let refused = false
    const pending = pair.client.sendRequest('worktree.list').catch(() => {
      refused = true
    })
    await pair.flush()
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
    // 31.25 events/second over a two-second link leaves almost no room for other requests.
    expect(spent.peakInFlight).toBeGreaterThanOrEqual(BRIDGE_MAX_PENDING_REQUESTS - 2)
    expect(spent.freeSlots).toBeLessThanOrEqual(2)
  }, 60_000)

  it('keeps the shipped drain within the request budget', async () => {
    const shell = createAudioShell()
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    await pair.flush()
    const spent = await runDictation(pair, shell, DICTATION_CAPTURE_DRAIN_INTERVAL_MS)
    // Two chunks/second over the same link holds four requests at unchanged audio throughput.
    expect(spent.peakInFlight).toBeLessThanOrEqual(6)
    expect(spent.refusals).toBe(0)
    expect(spent.freeSlots).toBeGreaterThanOrEqual(BRIDGE_MAX_PENDING_REQUESTS - 8)
    // Ten seconds sends 19 reads and 19 forwards; four forwarded replies remain in flight, keeping total bridge traffic under four frames/second.
    expect({ toShell: spent.framesToShell, toPage: spent.framesToPage }).toEqual({
      toShell: 38,
      toPage: 34
    })
    expect(spent.chunkRequests).toBeGreaterThanOrEqual(
      Math.floor(SESSION_MS / DICTATION_CAPTURE_DRAIN_INTERVAL_MS) - 1
    )
    expect(spent.chunkRequests).toBeLessThanOrEqual(
      Math.ceil(SESSION_MS / DICTATION_CAPTURE_DRAIN_INTERVAL_MS) + 1
    )
  }, 60_000)
})
