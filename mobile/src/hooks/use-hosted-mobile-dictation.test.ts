import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebSpeechEvent } from '../../../src/shared/mobile-web/speech-operation-contract'
import type { HostSessionDictationOperations } from '../session/host-session-dictation-operations'
import type { UseMobileDictationResult } from './mobile-dictation-session-state'
import { useHostedMobileDictation } from './use-hosted-mobile-dictation'

describe('useHostedMobileDictation', () => {
  let renderer: ReactTestRenderer | null = null
  let result: UseMobileDictationResult | null = null
  let onSpeechEvent: ((event: MobileWebSpeechEvent) => void) | null = null
  const onTranscript = vi.fn()
  const onError = vi.fn()
  const unsubscribe = vi.fn()
  const operations = {
    loadSetup: vi.fn(),
    downloadModel: vi.fn(),
    deleteModel: vi.fn(),
    configure: vi.fn(),
    subscribe: vi.fn((listener) => {
      onSpeechEvent = listener
      return { ready: Promise.resolve(), unsubscribe }
    }),
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn()
  } as unknown as HostSessionDictationOperations

  function Harness(): null {
    result = useHostedMobileDictation({
      operations,
      enabled: true,
      onTranscript,
      onError
    })
    return null
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    result = null
    onSpeechEvent = null
    onTranscript.mockReset()
    onError.mockReset()
    unsubscribe.mockReset()
    vi.mocked(operations.subscribe).mockClear()
    vi.mocked(operations.start).mockReset()
    vi.mocked(operations.stop).mockReset()
    vi.mocked(operations.cancel).mockReset().mockResolvedValue()
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('maps shell recording and transcript results into the existing hook contract', async () => {
    vi.mocked(operations.start).mockResolvedValue({ status: 'recording' })
    await act(async () => result?.start())
    expect(result?.isRecording).toBe(true)

    act(() => onSpeechEvent?.({ status: 'processing' }))
    expect(result?.isProcessing).toBe(true)

    vi.mocked(operations.stop).mockResolvedValue({
      status: 'transcript',
      text: 'spoken text'
    })
    await act(async () => result?.stop())

    expect(onTranscript).toHaveBeenCalledWith('spoken text')
    expect(result?.status).toBe('idle')
  })

  it('preserves setup-required error routing for the unchanged session UI', async () => {
    vi.mocked(operations.start).mockResolvedValue({
      status: 'setup-required',
      reason: 'voice_model_not_ready'
    })

    await expect(
      act(async () => {
        await result?.start()
      })
    ).rejects.toThrow('voice_model_not_ready:hosted')
    expect(result?.status).toBe('idle')
  })

  it('reports asynchronous shell audio failures and unsubscribes on unmount', () => {
    act(() => onSpeechEvent?.({ status: 'idle', reason: 'connection-slow' }))

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Connection is too slow') })
    )
    expect(result?.status).toBe('error')

    act(() => renderer?.unmount())
    renderer = null
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
