import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import { phoneNeedsYouAsks } from './phone-needs-you-asks'

function worker(
  dispatchId: string | undefined,
  title: string,
  state: BotChatTreeWorker['state']
): BotChatTreeWorker {
  return { key: `w-${title}`, title, state, startedAt: 1, ...(dispatchId ? { dispatchId } : {}) }
}

function chat(
  chatId: string,
  live: BotChatTreeChat['live'],
  running: BotChatTreeWorker[]
): BotChatTreeChat {
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live,
    lastActiveAt: 1,
    unread: false,
    closed: false,
    running,
    runningTotal: running.length,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0
  }
}

describe('phoneNeedsYouAsks', () => {
  it('lists waiting chats and workers, approvals first, an item’s worker under the item’s title', () => {
    const asks = phoneNeedsYouAsks(
      [
        chat('home', 'needs-you', [worker('d-q', 'Asks a question', 'needs-you')]),
        chat('side', 'idle', [
          worker('d-item', 'Webhook wake-up', 'needs-you'),
          worker('d-run', 'Still running', 'running'),
          worker(undefined, 'Handed agent', 'needs-you')
        ])
      ],
      (id) =>
        id === 'd-item'
          ? { dot: 'permission', tool: { name: 'Bash', input: 'git push' } }
          : { dot: 'waiting' },
      (id) => (id === 'd-item' ? { title: 'Wake the item’s chat', number: 35 } : null)
    )

    expect(
      asks.map((ask) => [ask.title, ask.number, ask.worker, ask.chatId, ask.approval])
    ).toEqual([
      ['Wake the item’s chat', 35, 'Webhook wake-up', 'side', true],
      ['home', null, null, 'home', false],
      ['Asks a question', null, null, 'home', false],
      ['Handed agent', null, null, 'side', false]
    ])
    expect(asks[0]!.tool).toEqual({ name: 'Bash', input: 'git push' })
    // Nothing locates a worker with no Dispatch and no workspace.
    expect(asks[3]!.open).toBeNull()
  })
})
