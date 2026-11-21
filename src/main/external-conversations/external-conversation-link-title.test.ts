import { describe, expect, it } from 'vitest'
import { findLink } from './external-conversation-links'
import { markThreadSeen, writeChatLink } from './external-conversation-link-writes'
import { fakeLinkStore, WORKTREE } from './external-conversation.test-fixture'
import type { ConversationKey } from './external-conversation-types'

const THREAD: ConversationKey = { source: 'slack', externalId: 'T1:C9:1700000000.0001' }
const chat = (sessionId: string) => ({
  worktreeId: WORKTREE,
  sessionId,
  agent: 'claude' as const,
  bot: { kind: 'bot' as const, botId: 'b1' }
})

describe('writeChatLink', () => {
  it('titles a link by the message that started it, and a relink keeps that title', () => {
    const { store } = fakeLinkStore()

    writeChatLink(store, THREAD, chat('s1'), 'Why did the nightly build fail?\nLogs attached.')
    expect(findLink(store, THREAD)?.link).toMatchObject({
      sessionId: 's1',
      title: 'Why did the nightly build fail?'
    })

    writeChatLink(store, THREAD, chat('s2'), 'and the one before it?')
    expect(findLink(store, THREAD)?.link).toMatchObject({
      sessionId: 's2',
      title: 'Why did the nightly build fail?'
    })
  })
})

describe('markThreadSeen', () => {
  it('keeps a bot thread new until its chat is first opened, and a relink keeps it seen', () => {
    const { store, folders } = fakeLinkStore()
    folders.push({ id: 'bot-home' })
    const home = { ...chat('s1'), worktreeId: 'folder:bot-home' }

    writeChatLink(store, THREAD, home)
    const link = findLink(store, THREAD)?.link
    expect(link?.seenAt).toBeNull()
    expect(link).not.toHaveProperty('title')
    expect(markThreadSeen(store, 'other', 5)).toBe(false)
    expect(markThreadSeen(store, 's1', 5)).toBe(true)
    expect(markThreadSeen(store, 's1', 9)).toBe(false)

    writeChatLink(store, THREAD, { ...home, sessionId: 's2' })
    expect(findLink(store, THREAD)?.link.seenAt).toBe(5)
  })
})
