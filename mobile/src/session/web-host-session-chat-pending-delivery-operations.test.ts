import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionChatPendingDeliveryOperations } from './web-host-session-chat-pending-delivery-operations'

describe('web host session chat pending delivery operations', () => {
  it('keeps the page tab handle out of the durable bridge payload', async () => {
    const pendingRead = vi
      .fn()
      .mockResolvedValue({ deliveries: [{ text: 'pending', expectedOccurrence: 1 }] })
    const pendingWrite = vi.fn().mockResolvedValue(null)
    const operations = webHostSessionChatPendingDeliveryOperations({
      nativeChat: { pendingRead, pendingWrite }
    } as unknown as MobileWebBridgeClient)

    await expect(operations.load('page-workspace', 'page-tab', 'page-session')).resolves.toEqual([
      { text: 'pending', expectedOccurrence: 1 }
    ])
    await operations.save('page-workspace', 'page-tab', 'page-session', [
      { text: 'next', expectedOccurrence: 2 }
    ])

    expect(pendingRead).toHaveBeenCalledWith({
      workspaceId: 'page-workspace',
      sessionId: 'page-session'
    })
    expect(pendingWrite).toHaveBeenCalledWith({
      workspaceId: 'page-workspace',
      sessionId: 'page-session',
      deliveries: [{ text: 'next', expectedOccurrence: 2 }]
    })
    expect(JSON.stringify([...pendingRead.mock.calls, ...pendingWrite.mock.calls])).not.toContain(
      'page-tab'
    )
  })
})
