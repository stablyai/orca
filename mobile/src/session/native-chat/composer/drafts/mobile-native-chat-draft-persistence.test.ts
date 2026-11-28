import { expect, it, vi } from 'vitest'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../../../../mobile-web-shell/page-storage/page-storage-keys'
import {
  loadMobileNativeChatDrafts,
  persistMobileNativeChatDrafts,
  setMobileNativeChatDraftSource
} from './mobile-native-chat-draft-persistence'
import type { MobileNativeChatSavedDraft } from './mobile-native-chat-saved-drafts'

const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => disk.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      disk.set(key, value)
    },
    removeItem: async (key: string) => {
      disk.delete(key)
    }
  }
}))

it('does not acknowledge a durable handoff when fitting discards the receiving draft', async () => {
  const drafts = new Map<string, MobileNativeChatSavedDraft>()
  const row = (text: string): MobileNativeChatSavedDraft => ({
    text,
    skills: [],
    images: [],
    files: [],
    inFlight: []
  })
  setMobileNativeChatDraftSource({ saved: () => drafts, restore: () => {} })
  await loadMobileNativeChatDrafts('paired', 'workspace')
  drafts.set('paired\0workspace\0first', row('first draft'))
  drafts.set('paired\0workspace\0reply', row('r'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS)))
  expect(await persistMobileNativeChatDrafts('paired', 'workspace')).toBe(false)
  drafts.set('paired\0workspace\0reply', row('recovered reply'))
  expect(await persistMobileNativeChatDrafts('paired', 'workspace')).toBe(true)
  expect([...disk.values()].join('')).toContain('recovered reply')
})
