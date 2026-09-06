import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_MARKDOWN_EDIT_MAX_BYTES } from '../../../src/shared/mobile-markdown-document'
import {
  loadMobileSessionMarkdownDraft,
  saveMobileSessionMarkdownDraft,
  type MobileSessionMarkdownDraftScope
} from './mobile-session-markdown-drafts'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

const BASE_SCOPE: MobileSessionMarkdownDraftScope = {
  hostIdentity: 'host-a',
  buildIdentity: 'build-a',
  workspaceIdentity: 'workspace-a',
  tabIdentity: 'tab-a',
  relativePath: 'notes.md'
}

describe('mobile session markdown drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('isolates drafts by every stable document authority', async () => {
    const scopes = [
      BASE_SCOPE,
      { ...BASE_SCOPE, hostIdentity: 'host-b' },
      { ...BASE_SCOPE, buildIdentity: 'build-b' },
      { ...BASE_SCOPE, workspaceIdentity: 'workspace-b' },
      { ...BASE_SCOPE, tabIdentity: 'tab-b' },
      { ...BASE_SCOPE, relativePath: 'other.md' }
    ]
    for (const scope of scopes) {
      await saveMobileSessionMarkdownDraft(scope, { content: 'draft', baseVersion: 'v1' })
    }

    const keys = vi.mocked(AsyncStorage.setItem).mock.calls.map(([key]) => key)
    expect(new Set(keys).size).toBe(scopes.length)
    expect(
      keys.every(
        (key) =>
          !key.includes('host-a') && !key.includes('workspace-a') && !key.includes('notes.md')
      )
    ).toBe(true)
  })

  it('removes null drafts and rejects oversized writes', async () => {
    await saveMobileSessionMarkdownDraft(BASE_SCOPE, null)
    await expect(
      saveMobileSessionMarkdownDraft(BASE_SCOPE, {
        content: 'x'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1),
        baseVersion: 'v1'
      })
    ).rejects.toThrow('invalid_markdown_draft')
    expect(AsyncStorage.removeItem).toHaveBeenCalledOnce()
  })

  it('rejects corrupt, oversized, and versionless stored drafts', async () => {
    for (const value of [
      '{',
      JSON.stringify({ content: 'draft', baseVersion: '' }),
      JSON.stringify({
        content: 'x'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1),
        baseVersion: 'v1'
      })
    ]) {
      vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(value)
      await expect(loadMobileSessionMarkdownDraft(BASE_SCOPE)).resolves.toBeNull()
    }
  })
})
