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
    const request = vi.fn().mockResolvedValue({ enabled: true, models: [] })
    const operations = webHostSessionDictationOperations({
      speech,
      host: { request }
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

    expect(request.mock.calls.map(([payload]) => payload)).toEqual([
      { method: 'speech.models.list', params: {} },
      { method: 'speech.models.download', params: { modelId: 'model-1' } },
      { method: 'speech.models.delete', params: { modelId: 'model-1' } },
      { method: 'speech.dictation.setup', params: { enabled: true } }
    ])
    expect(speech.subscribe).toHaveBeenCalledWith(onEvent, onError)
    expect(speech.start).toHaveBeenCalledOnce()
    expect(speech.stop).toHaveBeenCalledOnce()
    expect(speech.cancel).toHaveBeenCalledOnce()
  })
})
