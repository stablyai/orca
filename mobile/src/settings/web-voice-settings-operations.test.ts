import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webVoiceSettingsOperations } from './web-voice-settings-operations'

describe('hosted voice settings', () => {
  it('returns the desktop receipt for a configuration change without a second request', async () => {
    const request = vi.fn().mockResolvedValue({ enabled: false, models: [] })
    const operations = webVoiceSettingsOperations({
      host: { request }
    } as unknown as MobileWebBridgeClient)
    await expect(operations.configure({ enabled: true })).resolves.toEqual({
      enabled: false,
      models: []
    })
    expect(request).toHaveBeenCalledOnce()
  })
  it('does not replay an ambiguous model mutation through native speech', async () => {
    const request = vi.fn().mockRejectedValue(new Error('deadline elapsed'))
    const legacy = vi.fn()
    const operations = webVoiceSettingsOperations({
      host: { request },
      speech: { downloadModel: legacy }
    } as unknown as MobileWebBridgeClient)
    await expect(operations.download('model')).rejects.toThrow('deadline elapsed')
    expect(request).toHaveBeenCalledExactlyOnceWith({
      method: 'speech.models.download',
      params: { modelId: 'model' }
    })
    expect(legacy).not.toHaveBeenCalled()
  })
})
