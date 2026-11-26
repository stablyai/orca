import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat } from '../../../src/shared/bots/bot-chat-tree'
import type { WorkspaceListItem } from '../worktree/workspace-list/workspace-list-types'
import { hostBotChatItems } from './host-bot-chat-items'

function chat(chatId: string, origin: 'home' | 'side', extra: Partial<BotChatTreeChat> = {}) {
  return {
    chatId,
    title: chatId,
    origin,
    live: 'idle',
    lastActiveAt: 1,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...extra
  } satisfies BotChatTreeChat
}

function line(worktreeId: string): WorkspaceListItem {
  return {
    row: {
      worktreeId,
      repoId: 'repo',
      repo: 'repo',
      branch: worktreeId,
      displayName: worktreeId,
      path: `/repo/${worktreeId}`,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      unread: false,
      isPinned: false,
      linkedPR: null,
      isActive: false
    },
    view: { projectGroupDepth: 1 }
  }
}

function draw(steps: Record<string, number>): WorkspaceListItem[] {
  const items = hostBotChatItems({
    tree: {
      chats: [
        chat('home', 'home'),
        chat('replying', 'side', { live: 'replying' }),
        chat('quiet', 'side'),
        chat('closed', 'side', { closed: true })
      ],
      workspaceChats: {
        h1: 'home',
        h2: 'home',
        h3: 'home',
        q1: 'quiet',
        c1: 'closed',
        r1: 'replying'
      }
    },
    branches: ['h1', 'h2', 'h3', 'q1', 'c1', 'r1'].map((id) => ({ id, lines: [line(id)] })),
    home: line('home'),
    homeIdentity: 'home',
    hostKey: 'host',
    botId: 'bot',
    folds: {},
    steps,
    dimmed: false
  })
  return items ?? []
}

function shownRows(items: WorkspaceListItem[]): string[] {
  return items.map(({ row, view }) =>
    view.botChat
      ? `chat:${view.botChat.chat.chatId}`
      : view.botChatPaging
        ? `more:${view.botChatPaging.paging?.remaining ?? 0}`
        : row.worktreeId
  )
}

describe('hostBotChatItems', () => {
  // The project list leaves every bot workspace out, so one no listed chat has must still list
  // under the bot, or it shows nowhere on the phone (#47659).
  it('lists the workspaces of Home Chat and quiet or closed chats under the bot', () => {
    const first = draw({})
    expect(shownRows(first)).toEqual(['h1', 'h2', 'more:3', 'chat:replying'])
    const stepsKey = first.find(({ view }) => view.botChatPaging)?.view.botChatPaging?.stepsKey
    expect(shownRows(draw({ [stepsKey ?? '']: 1 }))).toEqual([
      'h1',
      'h2',
      'h3',
      'q1',
      'c1',
      'more:0',
      'chat:replying'
    ])
  })
})
