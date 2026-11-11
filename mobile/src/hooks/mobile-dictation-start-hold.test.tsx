// Real native capture seam: speech that arrives before the desktop's start reply must reach the host first, in order.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type SentRequest } from '../mobile-web-shell/bridge-host-test-fakes'

const mic = vi.hoisted(() => ({ emit: (_data: Uint8Array) => {} }))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: (
    name: string,
    listener: (event: { data: Uint8Array }) => void
  ) => {
    if (name === 'onMicrophoneData') {
      mic.emit = (data) => listener({ data })
    }
    return { remove: () => {} }
  },
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () => Promise.resolve({ granted: true }),
  tearDown: () => {},
  toggleRecording: () => true
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve()
  }
}

function chunkParams(request: SentRequest): unknown {
  return request.args[1]
}

describe('speech before the desktop answers start', () => {
  it('is sent first once start returns, ahead of later speech', async () => {
    const rpc = createFakeRpcClient()
    const held: { dictation: UseMobileDictationResult | null } = { dictation: null }
    function Probe(): null {
      held.dictation = useMobileDictation({ client: rpc, enabled: true, onTranscript: () => {} })
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })

    await act(async () => {
      void held.dictation?.start()
      await settle()
    })
    const start = rpc.requests.splice(0)
    expect(start.map((request) => request.method)).toEqual(['speech.dictation.start'])

    await act(async () => {
      mic.emit(Uint8Array.from([1, 2]))
      mic.emit(Uint8Array.from([3]))
      await settle()
    })
    expect(rpc.requests).toEqual([])

    await act(async () => {
      start[0].resolve({ id: 'desktop', ok: true, result: {} })
      await settle()
      mic.emit(Uint8Array.from([4]))
      await settle()
    })
    const startParams = start[0].args[1]
    const dictationId =
      typeof startParams === 'object' && startParams !== null && 'dictationId' in startParams
        ? startParams.dictationId
        : undefined
    expect(dictationId).toMatch(/^mobile-dictation-/)
    expect(held.dictation?.status).toBe('recording')
    expect(rpc.requests.map(chunkParams)).toEqual([
      { dictationId, audioBase64: 'AQID', sampleRate: 16000, seq: 0 },
      { dictationId, audioBase64: 'BA==', sampleRate: 16000, seq: 1 }
    ])
  })
})
