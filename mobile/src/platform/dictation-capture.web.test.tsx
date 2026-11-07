// Use real bridge/device handlers to verify pulled audio and refusal states reach the composer without crashing.
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
import { BRIDGE_AUDIO_RING_MAX_BYTES } from '../mobile-web-shell/bridge/bridge-audio-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { NativeVerbError } from '../mobile-web-shell/bridge/use-native-verbs'
import { createNativeAudioCapture, type NativeAudioEngine } from './native-audio'
import { useDictationCapture } from './dictation-capture.web'
import { DICTATION_CAPTURE_DRAIN_INTERVAL_MS } from './dictation-capture-contract'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import type { DictationCapture, DictationCaptureChunk } from './dictation-capture-contract'

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
    feedSpeech: () => {},
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
  it('reports a denied microphone as the state it is, never as a rejection', async () => {
    const shell = createAudioShell({ permission: 'denied' })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const capture = await mount(pair)
    await expect(capture.open()).resolves.toEqual({ ok: false, reason: 'permission-denied' })
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
    expect(shell.calls).toEqual([])
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
    expect(Array.from(chunks[0]?.data ?? [])).toEqual(Array.from(pcm(1_024)))
    sub.remove()
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
      vi.advanceTimersByTime(DICTATION_CAPTURE_DRAIN_INTERVAL_MS)
      shell.speak(afterwards)
      await capture.end()
      await pair.flush()
    })
    // Deliver every byte once and in order, regardless of whether read or stop carried it.
    expect(chunks.flatMap((chunk) => Array.from(chunk.data))).toEqual([
      ...Array.from(spoken),
      ...Array.from(afterwards)
    ])
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

  it('cannot re-enter end from an interruption raised while one is running', async () => {
    // Do not read from end(): refused reads invoke interruption, whose cancel calls end synchronously and would recurse until bridge exhaustion. Stop replies carry no interruption.
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
    expect(shell.calls.filter((verb) => verb === 'native.audio.stop').length).toBeLessThanOrEqual(2)
  })

  it('reads again for the next dictation after an end, rather than staying ended', async () => {
    // A second dictation on the same memoized capture must drain normally after the first end.
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
    // Open starts shell recording before begin; stale starts must still end the new capture even when begin never ran.
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
})
