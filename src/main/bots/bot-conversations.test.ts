import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { botConversations } from './bot-conversations'

const BOT: Bot = {
  id: 'b1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'fw-1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: 'chat-1',
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

function setup(bots: Bot[] = [BOT], enabled = true) {
  const chats = {
    ensureChat: vi.fn(async () => 'chat-1'),
    startSession: vi.fn(async () => 'thread-1')
  }
  return {
    chats,
    conversations: botConversations({
      bots: { enabled: () => enabled, list: () => bots },
      ...chats,
      botWork: { pullRequests: async () => [] }
    })
  }
}

describe('bot conversations', () => {
  it('opens a new chat in the bot’s home for a thread', async () => {
    const { chats, conversations } = setup()
    await expect(conversations.open({ kind: 'bot', botId: 'b1' })).resolves.toEqual({
      worktreeId: 'folder:fw-1',
      sessionId: 'thread-1',
      agent: 'codex'
    })
    expect(chats.ensureChat).not.toHaveBeenCalled()
  })

  it('routes direct messages to the bot’s Chat', async () => {
    const { chats, conversations } = setup()
    await expect(conversations.open({ kind: 'bot-chat', botId: 'b1' })).resolves.toMatchObject({
      sessionId: 'chat-1'
    })
    expect(chats.startSession).not.toHaveBeenCalled()
  })

  it('refuses an unknown or paused bot', () => {
    const { conversations } = setup([
      { ...BOT, paused: true },
      { ...BOT, id: 'b2' }
    ])
    expect(conversations.refusal('b1')).toBe('bot_paused')
    expect(conversations.refusal('nope')).toBe('bot_not_found')
    expect(conversations.refusal('b2')).toBeNull()
  })

  it('finds no bot while bots are turned off', () => {
    const { conversations } = setup([BOT], false)
    expect(conversations.refusal('b1')).toBe('bot_not_found')
  })
})
