/**
 * A tapped start that the composer's own send gate ends, while the microphone is still opening.
 *
 * On Android every mic tap used to raise the permission activity, and the resume behind it forces a
 * tabs reconciliation whose snapshot can briefly carry no active terminal — which is one of the two
 * inputs to `canSend`, the hook's `enabled`. The disable arrives inside `capture.open()`, so the tap
 * ended at idle with nothing said. Only the user's own cancel may end a tap in silence.
 */
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE } from './mobile-dictation-session-state'

type DeviceLog = {
  calls: string[]
  screen: string[]
  /** Resolves the permission ask, which is what the activity holds open on the device. */
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

/** Answers everything the hook has forwarded so far, a few rounds deep. */
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

describe('a tapped dictation start the composer disables while the microphone is opening', () => {
  it('reports the stop through onError instead of returning to idle in silence', async () => {
    const rpc = createFakeRpcClient()
    let renderer: ReactTestRenderer | null = null
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
    // The composer loses its send while the permission ask is still in flight.
    await act(async () => {
      renderer?.update(createElement(Probe, { client: rpc, enabled: false }))
      await pump(rpc)
    })
    // The activity goes away and the ask finally answers, too late to record anything.
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
      create(createElement(Probe, { client: rpc, enabled: true }))
    })
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await Promise.resolve()
    })
    await act(async () => {
      const cancelled = dictation().cancel()
      await pump(rpc)
      await cancelled
    })
    expect(errors).toEqual([])
    expect(dictation().status).toBe('idle')
  })
})
