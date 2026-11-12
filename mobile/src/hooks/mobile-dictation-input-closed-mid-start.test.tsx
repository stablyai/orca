// Android microphone permission can pause/resume the host inside capture.open; if canSend becomes false, report the interrupted tap rather than silently cancelling it.
// The cause of the activeHandle change on resume remains unproven; exercise the enabled seam independently of that cause.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE } from './mobile-dictation-session-state'

type DeviceLog = {
  calls: string[]
  screen: string[]
  releasePermission: (() => void) | null
}

const device = vi.hoisted((): DeviceLog => ({ calls: [], screen: [], releasePermission: null }))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'android' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => {
    device.calls.push('initialize')
    return Promise.resolve(true)
  },
  requestMicrophonePermissionsAsync: () =>
    new Promise((resolve) => {
      device.releasePermission = () => resolve({ granted: true })
    }),
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
const errors = new Array<string>()
let renderer: ReactTestRenderer | null = null

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

async function pump(rpc: FakeRpcClient): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      request.resolve({ id: 'desktop', ok: true, result: {} })
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

beforeEach(() => {
  device.calls.length = 0
  device.screen.length = 0
  device.releasePermission = null
  errors.length = 0
  held.dictation = null
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('a tapped dictation start the composer disables while the microphone is opening', () => {
  it('reports the stop through onError instead of returning to idle in silence', async () => {
    const rpc = createFakeRpcClient()
    act(() => {
      renderer = create(createElement(Probe, { client: rpc, enabled: true }))
    })
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await Promise.resolve()
    })
    expect(dictation().status).toBe('starting')
    await act(async () => {
      renderer?.update(createElement(Probe, { client: rpc, enabled: false }))
      await pump(rpc)
    })
    await act(async () => {
      device.releasePermission?.()
      await pump(rpc)
    })
    expect(errors).toEqual([MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE])
    expect(dictation().status).toBe('error')
    expect(device.calls).not.toContain('toggleRecording(true)')
  })

  it('keeps a cancel the user asked for silent', async () => {
    const rpc = createFakeRpcClient()
    act(() => {
      renderer = create(createElement(Probe, { client: rpc, enabled: true }))
    })
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await Promise.resolve()
    })
    expect(dictation().status).toBe('starting')
    expect(device.releasePermission).toEqual(expect.any(Function))
    await act(async () => {
      const cancelled = dictation().cancel()
      await pump(rpc)
      await cancelled
    })
    await act(async () => {
      device.releasePermission?.()
      await pump(rpc)
    })
    expect(errors).toEqual([])
    expect(dictation().status).toBe('idle')
    expect(device.calls).not.toContain('toggleRecording(true)')
  })
})
