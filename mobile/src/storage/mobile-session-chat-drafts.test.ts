import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadMobileSessionChatDraft,
  MOBILE_SESSION_CHAT_DRAFT_MAX_CHARACTERS,
  saveMobileSessionChatDraft,
  type MobileSessionChatDraftScope
} from './mobile-session-chat-drafts'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

const BASE_SCOPE: MobileSessionChatDraftScope = {
  hostIdentity: 'host-a',
  buildIdentity: 'build-a',
  workspaceIdentity: 'workspace-a',
  tabIdentity: 'tab-a'
}

describe('mobile session chat drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('isolates persisted drafts by host, build, workspace, and tab', async () => {
    await saveMobileSessionChatDraft(BASE_SCOPE, 'base')
    await saveMobileSessionChatDraft({ ...BASE_SCOPE, hostIdentity: 'host-b' }, 'host')
    await saveMobileSessionChatDraft({ ...BASE_SCOPE, buildIdentity: 'build-b' }, 'build')
    await saveMobileSessionChatDraft(
      { ...BASE_SCOPE, workspaceIdentity: 'workspace-b' },
      'workspace'
    )
    await saveMobileSessionChatDraft({ ...BASE_SCOPE, tabIdentity: 'tab-b' }, 'tab')

    const keys = vi.mocked(AsyncStorage.setItem).mock.calls.map(([key]) => key)
    expect(new Set(keys).size).toBe(5)
    expect(keys.every((key) => !key.includes('host-a') && !key.includes('workspace-a'))).toBe(true)
  })

  it('removes empty drafts and bounds stored text', async () => {
    await saveMobileSessionChatDraft(BASE_SCOPE, '')
    await saveMobileSessionChatDraft(
      BASE_SCOPE,
      'x'.repeat(MOBILE_SESSION_CHAT_DRAFT_MAX_CHARACTERS + 1)
    )

    expect(AsyncStorage.removeItem).toHaveBeenCalledOnce()
    expect(vi.mocked(AsyncStorage.setItem).mock.calls[0]?.[1]).toHaveLength(
      MOBILE_SESSION_CHAT_DRAFT_MAX_CHARACTERS
    )
  })

  it('rejects an oversized persisted value', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      'x'.repeat(MOBILE_SESSION_CHAT_DRAFT_MAX_CHARACTERS + 1)
    )
    await expect(loadMobileSessionChatDraft(BASE_SCOPE)).resolves.toBe('')
  })
})
