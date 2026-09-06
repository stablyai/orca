import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostTaskDeviceOperations } from './web-host-task-device-operations'

describe('web host task device operations', () => {
  it('uses only the named native bridge operations', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue({ confirmation: 'in-app' })
    const hapticFeedback = vi.fn().mockResolvedValue(null)
    const openExternal = vi.fn().mockResolvedValue(null)
    const operations = webHostTaskDeviceOperations({
      native: { clipboardWrite, hapticFeedback, openExternal }
    } as unknown as MobileWebBridgeClient)

    await operations.copyText('task link')
    operations.hapticMediumImpact()
    await operations.openExternalUrl('https://example.com/task')

    expect(clipboardWrite).toHaveBeenCalledWith('task link')
    expect(hapticFeedback).toHaveBeenCalledWith('medium-impact')
    expect(openExternal).toHaveBeenCalledWith('https://example.com/task')
  })
})
