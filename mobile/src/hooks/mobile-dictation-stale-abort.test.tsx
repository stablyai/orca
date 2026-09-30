/**
 * An abort whose desktop cancel is still in flight when a newer dictation takes over.
 *
 * `abandonDictation` reads what it will report before it awaits the cancel, and the await is a full
 * round trip to the desktop. A start that lands inside it owns the capture, the screen and the
 * status by the time the cancel answers, so the abort's own write is stale: reporting it would toast
 * over a live recording, and resetting it would idle one. The same await sits in the capture open
 * the abort races, which must not walk a recorded closure back to idle when it rejects late.
 */
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/bridge-host-test-fakes'
import { MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE } from './mobile-dictation-session-state'

type PermissionSettler = { grant: () => void; refuse: (error: unknown) => void }

type DeviceLog = {
  calls: string[]
  /** Every permission ask still waiting, in the order the hook made them. */
  permissions: PermissionSettler[]
}

const device = vi.hoisted((): DeviceLog => ({ calls: [], permissions: [] }))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'android' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () =>
    new Promise((resolve, reject) => {
      device.permissions.push({
        grant: () => resolve({ granted: true }),
        refuse: (error) => reject(error)
      })
    }),
  tearDown: () => device.calls.push('tearDown'),
  toggleRecording: (on: boolean) => {
    device.calls.push(`toggleRecording(${String(on)})`)
    return true
  }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }
const errors: string[] = []

function Probe({ client, enabled }: { client: FakeRpcClient; enabled: boolean }): null {
  held.dictation = useMobileDictation({
    client,
    enabled,
    onTranscript: () => {},
    onError: (error) => errors.push(error.message)
  })
  return null
}

function dictation(): UseMobileDictationResult {
  const current = held.dictation
  if (current === null) {
    throw new Error('nothing mounted')
  }
  return current
}

/** Answers every forwarded request, keeping the first of `hold` for the case to settle. */
async function pumpHolding(
  rpc: FakeRpcClient,
  hold: string,
  keep: { request: SentRequest | null }
): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      if (request.method === hold && keep.request === null) {
        keep.request = request
        continue
      }
      request.resolve({ id: 'desktop', ok: true, result: {} })
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

async function pump(rpc: FakeRpcClient): Promise<void> {
  await pumpHolding(rpc, 'none', { request: null })
}

/** Takes a mounted, enabled hook all the way to recording. */
async function reachRecording(rpc: FakeRpcClient): Promise<void> {
  await act(async () => {
    void dictation()
      .start()
      .catch(() => undefined)
    await Promise.resolve()
    device.permissions.shift()?.grant()
    await pump(rpc)
  })
  expect(dictation().status).toBe('recording')
}

beforeEach(() => {
  device.calls.length = 0
  device.permissions.length = 0
  errors.length = 0
  held.dictation = null
})

describe('an abort whose desktop cancel answers after a newer dictation is recording', () => {
  it('does not report the disable over the recording that replaced it', async () => {
    const rpc = createFakeRpcClient()
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(createElement(Probe, { client: rpc, enabled: true }))
    })
    await reachRecording(rpc)
    // The composer loses its send, and the abort's cancel stays in flight.
    const staleCancel: { request: SentRequest | null } = { request: null }
    // The disable Effect flushes when this scope ends, so the cancel it sends is held in the next.
    await act(async () => {
      renderer?.update(createElement(Probe, { client: rpc, enabled: false }))
    })
    await act(async () => {
      await pumpHolding(rpc, 'speech.dictation.cancel', staleCancel)
    })
    expect(staleCancel.request).not.toBeNull()
    // It comes back, and the user starts again — that start owns everything now.
    await act(async () => {
      renderer?.update(createElement(Probe, { client: rpc, enabled: true }))
      await pump(rpc)
    })
    await reachRecording(rpc)
    errors.length = 0
    // Only now does the old cancel answer.
    await act(async () => {
      staleCancel.request?.resolve({ id: 'desktop', ok: true, result: {} })
      await pump(rpc)
    })
    expect(errors).toEqual([])
    expect(dictation().status).toBe('recording')
    expect(dictation().error).toBeNull()
  })

  it('does not idle the recording that replaced a cancel the user asked for', async () => {
    const rpc = createFakeRpcClient()
    act(() => {
      create(createElement(Probe, { client: rpc, enabled: true }))
    })
    await reachRecording(rpc)
    const staleCancel: { request: SentRequest | null } = { request: null }
    await act(async () => {
      void dictation().cancel()
      await pumpHolding(rpc, 'speech.dictation.cancel', staleCancel)
    })
    expect(staleCancel.request).not.toBeNull()
    await reachRecording(rpc)
    await act(async () => {
      staleCancel.request?.resolve({ id: 'desktop', ok: true, result: {} })
      await pump(rpc)
    })
    expect(dictation().status).toBe('recording')
    expect(errors).toEqual([])
  })
})

describe('a capture open that rejects after the composer already closed the start', () => {
  it('keeps the closure the abort reported instead of walking it back to idle', async () => {
    const rpc = createFakeRpcClient()
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(createElement(Probe, { client: rpc, enabled: true }))
    })
    const started: { failure: unknown } = { failure: null }
    await act(async () => {
      void dictation()
        .start()
        .catch((error: unknown) => {
          started.failure = error
        })
      await Promise.resolve()
    })
    expect(dictation().status).toBe('starting')
    await act(async () => {
      renderer?.update(createElement(Probe, { client: rpc, enabled: false }))
      await pump(rpc)
    })
    expect(errors).toEqual([MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE])
    // The microphone the abort no longer owns now refuses, too late to say anything.
    await act(async () => {
      device.permissions.shift()?.refuse(new Error('microphone unavailable'))
      await pump(rpc)
    })
    expect(dictation().status).toBe('error')
    expect(dictation().error).toBe(MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE)
    // Nor is it rethrown: the composer toasts what `start` rejects with, and this start's refusal
    // would land on top of the closure the disable already reported.
    expect(started.failure).toBeNull()
    expect(errors).toEqual([MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE])
  })
})
