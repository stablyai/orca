import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadMobileSessionChatPendingDeliveries,
  MOBILE_SESSION_CHAT_PENDING_DELIVERY_LIMIT,
  MOBILE_SESSION_CHAT_PENDING_TEXT_MAX_CHARACTERS,
  saveMobileSessionChatPendingDeliveries,
  type MobileSessionChatPendingDeliveryScope
} from './mobile-session-chat-pending-deliveries'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

const BASE_SCOPE: MobileSessionChatPendingDeliveryScope = {
  hostIdentity: 'host-a',
  buildIdentity: 'build-a',
  workspaceIdentity: 'workspace-a',
  tabIdentity: 'tab-a',
  providerSessionIdentity: 'provider-session-a'
}

describe('mobile session chat pending deliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('isolates records by every stable delivery authority', async () => {
    const scopes = [
      BASE_SCOPE,
      { ...BASE_SCOPE, hostIdentity: 'host-b' },
      { ...BASE_SCOPE, buildIdentity: 'build-b' },
      { ...BASE_SCOPE, workspaceIdentity: 'workspace-b' },
      { ...BASE_SCOPE, tabIdentity: 'tab-b' },
      { ...BASE_SCOPE, providerSessionIdentity: 'provider-session-b' }
    ]
    for (const scope of scopes) {
      await saveMobileSessionChatPendingDeliveries(scope, [
        { text: 'pending', expectedOccurrence: 1 }
      ])
    }

    const keys = vi.mocked(AsyncStorage.setItem).mock.calls.map(([key]) => key)
    expect(new Set(keys).size).toBe(scopes.length)
    expect(
      keys.every(
        (key) =>
          !key.includes('host-a') &&
          !key.includes('workspace-a') &&
          !key.includes('provider-session-a')
      )
    ).toBe(true)
  })

  it('bounds stored records and removes empty state', async () => {
    await saveMobileSessionChatPendingDeliveries(BASE_SCOPE, [])
    await saveMobileSessionChatPendingDeliveries(
      BASE_SCOPE,
      Array.from({ length: MOBILE_SESSION_CHAT_PENDING_DELIVERY_LIMIT + 2 }, (_, index) => ({
        text: `pending-${index}`,
        expectedOccurrence: index + 1
      }))
    )

    expect(AsyncStorage.removeItem).toHaveBeenCalledOnce()
    expect(JSON.parse(vi.mocked(AsyncStorage.setItem).mock.calls[0]?.[1] ?? '[]')).toHaveLength(
      MOBILE_SESSION_CHAT_PENDING_DELIVERY_LIMIT
    )
  })

  it('rejects corrupt and oversized persisted entries', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
        { text: 'valid', expectedOccurrence: 2 },
        {
          text: 'x'.repeat(MOBILE_SESSION_CHAT_PENDING_TEXT_MAX_CHARACTERS + 1),
          expectedOccurrence: 3
        },
        { text: 'invalid-count', expectedOccurrence: 0 },
        { text: 42, expectedOccurrence: 4 }
      ])
    )

    await expect(loadMobileSessionChatPendingDeliveries(BASE_SCOPE)).resolves.toEqual([
      { text: 'valid', expectedOccurrence: 2 }
    ])
  })

  it('treats invalid JSON as empty state', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('{')
    await expect(loadMobileSessionChatPendingDeliveries(BASE_SCOPE)).resolves.toEqual([])
  })
})
