import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadMobileStructuredOutbox,
  MAX_MOBILE_STRUCTURED_OUTBOX_ENTRIES,
  saveMobileStructuredOutbox,
  type MobileStructuredOutboxEntry
} from './mobile-structured-outbox-store'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
}))

const ENTRY: MobileStructuredOutboxEntry = {
  clientMessageId: 'mobile-send:1:id',
  sessionId: 'mobile_1',
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
  previewUris: [],
  state: 'queued',
  queuedAt: 1,
  lastAttemptAt: null,
  retryAfterUnknownSubmittedAt: null
}

describe('mobile structured outbox store', () => {
  beforeEach(() => vi.clearAllMocks())

  it('persists queued messages and restores them after restart', async () => {
    await saveMobileStructuredOutbox('mobile_1', [ENTRY])
    const raw = vi.mocked(AsyncStorage.setItem).mock.calls[0]?.[1]
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(raw ?? null)

    await expect(loadMobileStructuredOutbox('mobile_1')).resolves.toEqual([ENTRY])
  })

  it('restores a killed in-flight dispatch as delivery unconfirmed', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([{ ...ENTRY, state: 'dispatching', lastAttemptAt: 4 }])
    )

    await expect(loadMobileStructuredOutbox('mobile_1')).resolves.toEqual([
      { ...ENTRY, state: 'unconfirmed', lastAttemptAt: 4 }
    ])
  })

  it('drops malformed and cross-session entries', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([ENTRY, { ...ENTRY, sessionId: 'mobile_2' }, { nope: true }])
    )

    await expect(loadMobileStructuredOutbox('mobile_1')).resolves.toEqual([ENTRY])
  })

  it('rejects overflow instead of silently deleting older queued messages', async () => {
    const entries = Array.from(
      { length: MAX_MOBILE_STRUCTURED_OUTBOX_ENTRIES + 1 },
      (_, index) => ({
        ...ENTRY,
        clientMessageId: `mobile-send:${index}:id`,
        queuedAt: index
      })
    )

    await expect(saveMobileStructuredOutbox('mobile_1', entries)).rejects.toThrow('outbox is full')
    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
  })
})
