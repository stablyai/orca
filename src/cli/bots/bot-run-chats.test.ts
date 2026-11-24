import { describe, expect, it } from 'vitest'
import { formatRunChats } from './bot-run-chats'

describe('orca bot run-chats', () => {
  it('prints counts by reason, never a chat title', () => {
    const chat = { chatId: 'c1', title: 'Customer reply draft', lastActivityAt: 0, items: [] }
    const text = formatRunChats({
      bot: 'Nightly',
      on: false,
      open: 5,
      notRunChats: 2,
      close: [{ ...chat, items: [{ number: 11, status: 'done' }] }],
      keep: [
        { ...chat, chatId: 'c2', keep: ['thread', 'recent'] },
        { ...chat, chatId: 'c3', keep: ['thread'] }
      ],
      itemMailTo: { chatId: 'home', title: 'Home title' }
    })
    expect(text).toBe(
      [
        'Nightly: closing ended run chats is off.',
        'Open chats: 5 (3 opened by a run, 2 not).',
        'Would close now: 1 (1 own items; their mail then reaches the Home Chat).',
        'Would keep: 2, by reason (a chat can have several):',
        '  recent: 1',
        '  thread: 2'
      ].join('\n')
    )
    expect(text).not.toMatch(/Customer|Home title/)
  })
})
