// Use the real native capture/keep-awake seams: desktop refusal arrives after the microphone and screen are held, so both device resources must be released (ruling 36).
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient
} from '../mobile-web-shell/test-support/bridge-host-test-fakes'

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
