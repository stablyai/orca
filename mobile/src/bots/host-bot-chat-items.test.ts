import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat } from '../../../src/shared/bots/bot-chat-tree'
import { botChatFoldKey } from '../../../src/shared/bots/bot-chat-tree'
import type { WorkspaceListItem, Worktree } from '../worktree/workspace-list/workspace-list-types'
import { hostBotChatItems } from './host-bot-chat-items'

const chat = (chatId: string, extra: Partial<BotChatTreeChat> = {}): BotChatTreeChat => ({
  chatId,
  title: chatId,
  origin: 'side',
  live: 'idle',
  lastActiveAt: 0,
  unread: false,
  closed: false,
  tab: true,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0,
  ...extra
})

const item = (worktreeId: string): WorkspaceListItem => {
  const row: Worktree = {
    worktreeId,
    repoId: 'repo-1',
    repo: 'acme-web',
    branch: worktreeId,
    displayName: worktreeId,
    path: `/repo/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
  return { row, view: { botWorkspace: true, projectGroupDepth: 1 } }
}

const home = item('folder:home')

/** Each item as the list draws it: a chat's id, a line's name and depth, or the paging. */
function shape(items: WorkspaceListItem[] | null) {
  return items?.map(({ row, view }) =>
    view.botChat
      ? `chat ${view.botChat.chat.chatId}${view.botChat.open ? ' open' : ''}`
      : view.botChatPaging
        ? `more ${view.botChatPaging.paging?.remaining ?? 0}`
        : `line ${row.worktreeId} ${view.botChatLine?.depth}${view.botChatLine?.note ? ` ${JSON.stringify(view.botChatLine.note)}` : ''}`
  )
}

function draw(
  chats: BotChatTreeChat[],
  branches: { id: string; lines: WorkspaceListItem[] }[],
  options: { folds?: Record<string, 'open' | 'folded'> } = {}
) {
  return hostBotChatItems({
    tree: {
      chats,
      workspaceChats: { 'wt-b': 'slack' }
    },
    branches,
    home,
    homeIdentity: 'local::folder:home',
    hostKey: 'paired\nlocal',
    botId: 'bot-1',
    folds: Object.fromEntries(
      Object.entries(options.folds ?? {}).map(([chatId, fold]) => [
        botChatFoldKey('paired\nlocal', 'bot-1', chatId),
        fold
      ])
    ),
    steps: {},
    dimmed: false
  })
}

describe('hostBotChatItems', () => {
  it("lists each open chat with its workers' lines one level down, children deeper", () => {
    const child = item('wt-a-child')
    child.view = { ...child.view, projectGroupDepth: 2 }
    const items = draw(
      [chat('home', { origin: 'home' }), chat('slack', { origin: 'slack' })],
      [
        { id: 'wt-a', lines: [item('wt-a'), child] },
        { id: 'wt-b', lines: [item('wt-b')] }
      ],
      { folds: { home: 'open', slack: 'open' } }
    )
    expect(shape(items)).toEqual([
      'chat home open',
      'line wt-a 1',
      'line wt-a-child 2',
      'chat slack open',
      'line wt-b 1'
    ])
  })

  it("hides a folded chat's lines, and pages a long chat after its last 2 finished", () => {
    const branches = ['w0', 'w1', 'w2', 'w3', 'w4'].map((id) => ({ id, lines: [item(id)] }))
    expect(shape(draw([chat('home', { origin: 'home' })], branches))).toEqual(['chat home'])
    expect(
      shape(draw([chat('home', { origin: 'home' })], branches, { folds: { home: 'open' } }))
    ).toEqual(['chat home open', 'line w0 1', 'line w1 1', 'more 3'])
  })

  it('keeps the flat lines for a bot with no chats read', () => {
    expect(draw([], [{ id: 'wt-a', lines: [item('wt-a')] }])).toBeNull()
  })
})
