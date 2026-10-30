// Use the real native capture/keep-awake seams: desktop refusal arrives after the microphone and screen are held, so both device resources must be released (ruling 36).
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/bridge-host-test-fakes'

const device = vi.hoisted(() => ({
  calls: new Array<string>(),
  screen: new Array<string>()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => {
    device.calls.push('initialize')
    return Promise.resolve(true)
  },
  requestMicrophonePermissionsAsync: () => Promise.resolve({ granted: true }),
  tearDown: () => device.calls.push('tearDown'),
  toggleRecording: (on: boolean) => {
    device.calls.push(`toggleRecording(${String(on)})`)
    return true
  }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => {
    device.screen.push('+')
    return Promise.resolve()
  },
  deactivateKeepAwake: () => {
    device.screen.push('-')
    return Promise.resolve()
  }
}))

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }
let renderer: ReactTestRenderer | null = null

function mount(client: FakeRpcClient): void {
  function Probe(): null {
    held.dictation = useMobileDictation({
      client,
      enabled: true,
      onTranscript: () => {},
      onError: () => {}
    })
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
}

function dictation(): UseMobileDictationResult {
  const current = held.dictation
  if (current === null) {
    throw new Error('nothing mounted')
  }
  return current
}

async function pumpHolding(
  rpc: FakeRpcClient,
  hold: string,
  held: { request: SentRequest | null }
): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      if (request.method === hold && held.request === null) {
        held.request = request
        continue
      }
      request.resolve({ id: 'desktop', ok: true, result: {} })
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

async function pump(rpc: FakeRpcClient, refuse: string): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      request.resolve(
        request.method === refuse
          ? { id: 'desktop', ok: false, error: { code: 'refused', message: 'no model installed' } }
          : { id: 'desktop', ok: true, result: {} }
      )
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

beforeEach(() => {
  device.calls.length = 0
  device.screen.length = 0
  held.dictation = null
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('a native start the desktop refuses', () => {
  it('gives the microphone and the screen back', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    await act(async () => {
      const started = dictation()
        .start()
        .catch(() => undefined)
      await pump(rpc, 'speech.dictation.start')
      await started
    })
    expect(device.calls).toContain('initialize')
    expect(device.calls).toContain('tearDown')
    // The open capture owns a wake tag; no outer start catch releases it.
    expect(device.screen).toEqual(['+', '-'])
    expect(dictation().status).toBe('idle')
  })
})

describe('a stale native start whose refusal arrives after a newer one is recording', () => {
  it('leaves the newer dictation recording, with the microphone and the screen still its own', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    const first: { request: SentRequest | null } = { request: null }
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await pumpHolding(rpc, 'speech.dictation.start', first)
    })
    expect(first.request).not.toBeNull()
    expect(device.screen).toEqual(['+'])
    await act(async () => {
      const cancelled = dictation().cancel()
      await pump(rpc, 'none')
      await cancelled
    })
    await act(async () => {
      const started = dictation()
        .start()
        .catch(() => undefined)
      await pump(rpc, 'none')
      await started
    })
    expect(dictation().status).toBe('recording')
    const screenWhileRecording = [...device.screen]
    const callsWhileRecording = [...device.calls]
    // A no longer owns the microphone or screen; late failure must leave B alone.
    await act(async () => {
      first.request?.resolve({
        id: 'desktop',
        ok: false,
        error: { code: 'refused', message: 'no model installed' }
      })
      await pump(rpc, 'none')
    })
    expect(dictation().status).toBe('recording')
    expect(device.screen).toEqual(screenWhileRecording)
    expect(device.calls).toEqual(callsWhileRecording)
  })
})

describe('a stale native start that succeeds after a newer one is recording', () => {
  it('does not commit itself over the dictation that replaced it', async () => {
    // A’s late success must cancel only its desktop session, leaving B’s capture untouched.
    const rpc = createFakeRpcClient()
    mount(rpc)
    const first: { request: SentRequest | null } = { request: null }
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await pumpHolding(rpc, 'speech.dictation.start', first)
    })
    expect(first.request).not.toBeNull()
    await act(async () => {
      const cancelled = dictation().cancel()
      await pump(rpc, 'none')
      await cancelled
    })
    await act(async () => {
      const started = dictation()
        .start()
        .catch(() => undefined)
      await pump(rpc, 'none')
      await started
    })
    expect(dictation().status).toBe('recording')
    const screenWhileRecording = [...device.screen]
    const callsWhileRecording = [...device.calls]
    await act(async () => {
      first.request?.resolve({ id: 'desktop', ok: true, result: { started: true } })
      await pump(rpc, 'none')
    })
    expect(dictation().status).toBe('recording')
    expect(device.screen).toEqual(screenWhileRecording)
    expect(device.calls).toEqual(callsWhileRecording)
  })
})
