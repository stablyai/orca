import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const audio = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<boolean>>(),
  requestMicrophonePermissionsAsync: vi.fn<() => Promise<{ granted: boolean }>>(),
  toggleRecording: vi.fn<(val: boolean) => boolean>(),
  tearDown: vi.fn(),
  addListener: vi.fn(() => ({ remove: vi.fn() }))
}))

vi.mock('@orca/expo-two-way-audio', () => ({
  initialize: audio.initialize,
  requestMicrophonePermissionsAsync: audio.requestMicrophonePermissionsAsync,
  toggleRecording: audio.toggleRecording,
  tearDown: audio.tearDown,
  addExpoTwoWayAudioEventListener: audio.addListener
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
  Platform: { OS: 'ios' }
}))

vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: vi.fn(async () => undefined),
  deactivateKeepAwake: vi.fn(async () => undefined)
}))

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'
import type { RpcClient } from '../transport/rpc-client'

describe('mobile dictation when the native audio engine is unavailable', () => {
  let renderer: ReactTestRenderer | null = null
  let dictation: UseMobileDictationResult | null = null
  let consoleSpy: MockInstance
  const sendRequest = vi.fn(async () => ({ ok: true, result: {} }))

  function Harness(): null {
    dictation = useMobileDictation({
      client: { sendRequest } as unknown as RpcClient,
      enabled: true,
      onTranscript: () => undefined
    })
    return null
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    sendRequest.mockClear()
    audio.initialize.mockReset()
    audio.toggleRecording.mockReset().mockReturnValue(true)
    audio.tearDown.mockReset()
    audio.requestMicrophonePermissionsAsync.mockReset().mockResolvedValue({ granted: true })
    const original = console.error
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    act(() => {
      renderer = create(createElement(Harness))
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    dictation = null
    consoleSpy.mockRestore()
  })

  // The iOS Simulator guard and the web stub both report unavailability by
  // resolving initialize() to false. Returning to 'idle' is what keeps the mic
  // control usable afterwards; a rejection here would strand it in 'starting'.
  it('returns to idle and opens no desktop session when initialize resolves false', async () => {
    audio.initialize.mockResolvedValue(false)

    await act(async () => {
      await expect(dictation?.start()).rejects.toThrow('Failed to initialize microphone')
    })

    expect(dictation?.status).toBe('idle')
    expect(dictation?.error).toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
    expect(audio.toggleRecording).not.toHaveBeenCalled()
  })

  it('starts the desktop session when initialize resolves true', async () => {
    audio.initialize.mockResolvedValue(true)

    await act(async () => {
      await dictation?.start()
    })

    expect(sendRequest).toHaveBeenCalledWith('speech.dictation.start', expect.anything())
  })
})
