import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionDictationOperations } from './web-host-session-dictation-operations'

describe('webHostSessionDictationOperations', () => {
  it('routes setup, lifecycle, and subscriptions through the speech bridge client', async () => {
    const speech = {
      setup: vi.fn().mockResolvedValue({ models: [] }),
      downloadModel: vi.fn().mockResolvedValue(null),
      deleteModel: vi.fn().mockResolvedValue({ models: [] }),
      configure: vi.fn().mockResolvedValue({ models: [] }),
      subscribe: vi.fn().mockReturnValue({ ready: Promise.resolve(), unsubscribe: vi.fn() }),
      start: vi.fn().mockResolvedValue({ status: 'recording' }),
      stop: vi.fn().mockResolvedValue({ status: 'no-speech' }),
      cancel: vi.fn().mockResolvedValue(null)
    }
    const operations = webHostSessionDictationOperations({
      speech
    } as unknown as MobileWebBridgeClient)
    const onEvent = vi.fn()
    const onError = vi.fn()

    await operations.loadSetup()
    await operations.downloadModel('model-1')
    await operations.deleteModel('model-1')
    await operations.configure({ enabled: true })
    operations.subscribe(onEvent, onError)
    await operations.start()
    await operations.stop()
    await operations.cancel()

    expect(speech.setup).toHaveBeenCalledOnce()
    expect(speech.downloadModel).toHaveBeenCalledWith('model-1')
    expect(speech.deleteModel).toHaveBeenCalledWith('model-1')
    expect(speech.configure).toHaveBeenCalledWith({ enabled: true })
    expect(speech.subscribe).toHaveBeenCalledWith(onEvent, onError)
    expect(speech.start).toHaveBeenCalledOnce()
    expect(speech.stop).toHaveBeenCalledOnce()
    expect(speech.cancel).toHaveBeenCalledOnce()
  })
})
