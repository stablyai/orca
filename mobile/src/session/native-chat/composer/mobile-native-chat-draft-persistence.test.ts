import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearMobileNativeChatDraftForSend,
  editMobileNativeChatDraft,
  pruneMobileNativeChatTabDrafts,
  readMobileNativeChatDraftEditGeneration,
  readMobileNativeChatPickedSkills,
  recordMobileNativeChatSkillPick,
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import {
  loadMobileNativeChatDrafts,
  mobileNativeChatDraftWritesSettledForTests
} from './mobile-native-chat-draft-persistence'
import { readMobileNativeChatDraftInputs } from './mobile-native-chat-draft-inputs'

const storage = vi.hoisted(() => new Map<string, string>())
// A host-area page reads the key over the bridge, so its load can land after the user acts.
const slowRead = vi.hoisted(() => ({ gate: null as Promise<void> | null }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      await slowRead.gate
      return storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: async (key: string) => {
      storage.delete(key)
    }
  }
}))

const TAB_A = 'host-1\0wt-1\0tab-a'
const TAB_B = 'host-1\0wt-1\0tab-b'

async function settle(): Promise<void> {
  await vi.runAllTimersAsync()
  await mobileNativeChatDraftWritesSettledForTests()
}

// The page document dies with the app; storage is all that survives.
async function relaunch(): Promise<void> {
  resetMobileNativeChatDraftStoreForTests()
  await loadMobileNativeChatDrafts('host-1', 'wt-1')
}

function draftText(scope: string): string {
  let text = ''
  function Reader(): null {
    text = useMobileNativeChatDraft(scope)
    return null
  }
  let reader: ReturnType<typeof create> | null = null
  act(() => {
    reader = create(createElement(Reader))
  })
  act(() => reader?.unmount())
  return text
}

describe('mobile native-chat draft persistence', () => {
  afterEach(() => {
    resetMobileNativeChatDraftStoreForTests()
    storage.clear()
    slowRead.gate = null
    vi.useRealTimers()
  })

  it('brings back a draft and its skill picks after a relaunch', async () => {
    vi.useFakeTimers()
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    recordMobileNativeChatSkillPick(TAB_A, { token: '$review', path: '/skills/review/SKILL.md' })
    editMobileNativeChatDraft(TAB_A, '$review the auth change')
    await settle()

    await relaunch()

    expect(draftText(TAB_A)).toBe('$review the auth change')
    expect(readMobileNativeChatPickedSkills(TAB_A)).toEqual([
      { name: 'review', path: '/skills/review/SKILL.md' }
    ])
  })

  it('never brings back a sent draft', async () => {
    vi.useFakeTimers()
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    editMobileNativeChatDraft(TAB_A, 'ship it')
    await settle()
    clearMobileNativeChatDraftForSend(
      TAB_A,
      readMobileNativeChatDraftEditGeneration(TAB_A),
      'ship it'
    )
    await mobileNativeChatDraftWritesSettledForTests()

    await relaunch()

    expect(draftText(TAB_A)).toBe('')
  })

  it('keeps a send made before the saved drafts finished loading', async () => {
    vi.useFakeTimers()
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    editMobileNativeChatDraft(TAB_A, 'old draft')
    await settle()
    resetMobileNativeChatDraftStoreForTests()
    let release = (): void => {}
    slowRead.gate = new Promise((resolve) => {
      release = resolve
    })
    const loading = loadMobileNativeChatDrafts('host-1', 'wt-1')

    editMobileNativeChatDraft(TAB_A, 'sent before load')
    clearMobileNativeChatDraftForSend(
      TAB_A,
      readMobileNativeChatDraftEditGeneration(TAB_A),
      'sent before load'
    )
    slowRead.gate = null
    release()
    await loading
    await mobileNativeChatDraftWritesSettledForTests()

    expect(draftText(TAB_A)).toBe('')
    await relaunch()
    expect(draftText(TAB_A)).toBe('')
  })

  it('drops saved drafts of tabs the host no longer lists', async () => {
    vi.useFakeTimers()
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    editMobileNativeChatDraft(TAB_A, 'keep me')
    editMobileNativeChatDraft(TAB_B, 'closed elsewhere')
    await settle()
    await relaunch()

    pruneMobileNativeChatTabDrafts('host-1', 'wt-1', ['tab-a'])
    await mobileNativeChatDraftWritesSettledForTests()
    await relaunch()

    expect(draftText(TAB_A)).toBe('keep me')
    expect(draftText(TAB_B)).toBe('')
    expect(readMobileNativeChatDraftInputs(TAB_B).skills).toEqual([])
  })
})
