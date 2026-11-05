import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrackedJournalOpener } from './agent-session-journal/journal-host-database-test-support'
import { TerminalChatQueue } from './terminal-chat-queue'
import type { NativeChatTerminalActivity } from '../../shared/native-chat/native-chat-terminal-queue'

describe('terminal chat journal queue', () => {
  const journals = createTrackedJournalOpener()
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'terminal-chat-queue-'))
  })
  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const open = () =>
    journals.open({
      stateDirectory: root,
      identity: {
        sessionId: 'terminal-chat:term',
        workspaceId: 'folder-workspace',
        hostId: 'host',
        agent: 'hermes',
        providerHandle: null
      }
    })

  it('queues while busy and drains one message per real turn, in order', async () => {
    const journal = await open()
    let activity: NativeChatTerminalActivity = { state: 'working', workingSequence: 1 }
    const send = vi.fn(async () => true)
    const queue = new TerminalChatQueue(journal, () => activity, send)
    await queue.enqueue('first', 'First')
    await queue.enqueue('second', 'Second')
    await queue.drain()
    expect(send).not.toHaveBeenCalled()
    expect(queue.snapshot().queuedMessages.map((card) => card.messageId)).toEqual([
      'first',
      'second'
    ])
    activity = { state: 'idle', workingSequence: 1, inputReady: true }
    await queue.drain()
    expect(send.mock.calls).toEqual([['First']])
    await queue.drain()
    expect(send).toHaveBeenCalledTimes(1)
    activity = { state: 'working', workingSequence: 2 }
    await queue.drain()
    expect(send).toHaveBeenCalledTimes(1)
    activity = { state: 'idle', workingSequence: 2, inputReady: true }
    await queue.drain()
    expect(send.mock.calls).toEqual([['First'], ['Second']])
    expect(queue.snapshot().queuedMessages).toEqual([])
  })

  it('never drains an unreadable or occupied composer and honors cancellation', async () => {
    const journal = await open()
    let activity: NativeChatTerminalActivity = { state: null, workingSequence: 0 }
    const send = vi.fn(async () => true)
    const queue = new TerminalChatQueue(journal, () => activity, send)
    await queue.enqueue('first', 'First')
    await queue.enqueue('second', 'Second')
    await queue.drain()
    expect(send).not.toHaveBeenCalled()
    await journal.queuedMessages.withdraw(['first'])
    activity = { state: 'idle', workingSequence: 0, inputReady: false }
    await queue.drain()
    expect(send).not.toHaveBeenCalled()
    activity.inputReady = true
    await queue.drain()
    expect(send.mock.calls).toEqual([['Second']])
  })

  it('holds unknown delivery without replaying it or passing later messages', async () => {
    const journal = await open()
    const activity: NativeChatTerminalActivity = {
      state: 'idle',
      workingSequence: 0,
      inputReady: true
    }
    const send = vi.fn(async () => {
      throw new Error('lost acknowledgment')
    })
    const queue = new TerminalChatQueue(journal, () => activity, send)
    await queue.enqueue('first', 'First')
    await queue.enqueue('second', 'Second')
    await queue.drain()
    activity.workingSequence = 1
    await queue.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(queue.snapshot().queuedMessages[0]).toMatchObject({ messageId: 'first', paused: true })
  })

  it('retains order and retries when readiness changes before any bytes are written', async () => {
    const journal = await open()
    const send = vi.fn(async () => true).mockResolvedValueOnce(false)
    const queue = new TerminalChatQueue(
      journal,
      () => ({ state: 'idle', workingSequence: 0, inputReady: true }),
      send
    )
    await queue.enqueue('first', 'First')
    await queue.enqueue('second', 'Second')
    await queue.drain()
    expect(queue.snapshot().queuedMessages.map((card) => card.messageId)).toEqual([
      'first',
      'second'
    ])
    await queue.drain()
    expect(send.mock.calls).toEqual([['First'], ['First']])
  })

  it('keeps a card being copied for editing ahead of later cards until it is cancelled', async () => {
    const journal = await open()
    const send = vi.fn(async () => true)
    const queue = new TerminalChatQueue(
      journal,
      () => ({ state: 'idle', workingSequence: 0, inputReady: true }),
      send
    )
    await queue.enqueue('first', 'First')
    await queue.enqueue('second', 'Second')
    await journal.queuedMessages.hold({ messageIds: ['first'], reason: 'editing' })
    await queue.drain()
    expect(send).not.toHaveBeenCalled()
    await journal.queuedMessages.withdraw(['first'])
    await queue.drain()
    expect(send.mock.calls).toEqual([['Second']])
  })

  it('allows later messages after the person cancels an uncertain send and the input is ready', async () => {
    const journal = await open()
    const send = vi.fn(async () => true).mockRejectedValueOnce(new Error('lost receipt'))
    const queue = new TerminalChatQueue(
      journal,
      () => ({ state: 'idle', inputReady: true, workingSequence: 0 }),
      send
    )
    await queue.enqueue('first', 'First')
    await queue.enqueue('second', 'Second')
    await queue.drain()
    await queue.cancel(['first'])
    await queue.drain()
    expect(send.mock.calls).toEqual([['First'], ['Second']])
  })
})
