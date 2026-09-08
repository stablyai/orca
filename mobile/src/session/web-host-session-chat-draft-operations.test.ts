import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionChatDraftOperations } from './web-host-session-chat-draft-operations'

describe('web host session chat draft operations', () => {
  it('uses only opaque page workspace and tab identities', async () => {
    const sessionChatDraftRead = vi.fn().mockResolvedValue({ text: 'saved' })
    const sessionChatDraftWrite = vi.fn().mockResolvedValue(null)
    const operations = webHostSessionChatDraftOperations({
      native: { sessionChatDraftRead, sessionChatDraftWrite }
    } as unknown as MobileWebBridgeClient)

    await expect(operations.load('page-workspace', 'page-tab')).resolves.toBe('saved')
    await expect(operations.save('page-workspace', 'page-tab', 'next')).resolves.toBeUndefined()

    expect(sessionChatDraftRead).toHaveBeenCalledWith('page-workspace', 'page-tab')
    expect(sessionChatDraftWrite).toHaveBeenCalledWith('page-workspace', 'page-tab', 'next')
  })
})
