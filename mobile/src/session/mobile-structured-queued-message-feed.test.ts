import { describe, expect, it } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { mobileQueuePauseLabel } from './mobile-structured-queued-message-cards'
import {
  reduceMobileQueuePause,
  reduceMobileQueuedMessageFeed
} from './mobile-structured-queued-message-feed'

function draft(messageId: string, position: number): AgentSessionQueuedMessage {
  return {
    messageId,
    position,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `text ${messageId}` }] },
    state: 'waiting'
  }
}

function batch(
  queuedMessages?: AgentSessionQueuedMessage[] | null,
  queuePause?: AgentSessionQueuePause | null
): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'session-1',
    batch: { cursor: { epoch: 'e', sequence: 1 }, items: [], removedItemIds: [], submissions: [] },
    ...(queuedMessages !== undefined ? { queuedMessages } : {}),
    ...(queuePause !== undefined ? { queuePause } : {})
  }
}

describe('reduceMobileQueuePause', () => {
  it('rides with the list: a frame without the list keeps it, one with the list states it', () => {
    const paused = reduceMobileQueuePause(null, batch([draft('a', 1)], { reason: 'stopped' }))
    expect(paused).toEqual({ reason: 'stopped' })
    expect(reduceMobileQueuePause(paused, batch())).toBe(paused)
    expect(reduceMobileQueuePause(paused, batch([draft('a', 1)], { reason: 'stopped' }))).toBe(
      paused
    )
    expect(reduceMobileQueuePause(paused, batch([draft('a', 1)]))).toBeNull()
  })

  it('keeps a pause that names no reason, which reads as a plain pause', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a malformed or newer host's pause, with no reason this build can read.
    const reasonless = {} as AgentSessionQueuePause
    const paused = reduceMobileQueuePause(null, batch([draft('a', 1)], reasonless))
    expect(paused).toBe(reasonless)
    expect(mobileQueuePauseLabel(reasonless)).toBe('Queue paused')
  })
})

describe('reduceMobileQueuedMessageFeed', () => {
  it('holds no claim until the host publishes the field', () => {
    expect(reduceMobileQueuedMessageFeed(null, batch())).toBeNull()
  })

  it('adopts a published list ordered by position', () => {
    const next = reduceMobileQueuedMessageFeed(null, batch([draft('b', 2), draft('a', 1)]))
    expect(next?.map((entry) => entry.messageId)).toEqual(['a', 'b'])
  })

  it('keeps the last list when a frame omits the field', () => {
    const held = reduceMobileQueuedMessageFeed(null, batch([draft('a', 1)]))
    expect(reduceMobileQueuedMessageFeed(held, batch())).toBe(held)
  })

  it('reads null as empty', () => {
    const held = reduceMobileQueuedMessageFeed(null, batch([draft('a', 1)]))
    expect(reduceMobileQueuedMessageFeed(held, batch(null))).toEqual([])
  })

  it('never advances on the end frame', () => {
    const held = reduceMobileQueuedMessageFeed(null, batch([draft('a', 1)]))
    expect(reduceMobileQueuedMessageFeed(held, { type: 'end' })).toBe(held)
  })
})
