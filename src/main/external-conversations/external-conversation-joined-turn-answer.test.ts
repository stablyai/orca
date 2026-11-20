import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConnectorTurnEvents } from '../connector-cloud/connector-turn-events'
import type { ConnectorEvent } from '../../shared/connectors/connector-cloud-contract'
import { mailStartedBot } from './external-conversation-prompt-turns.test-fixture'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-joined-turn-answer-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A person who speaks in the thread during a bot's turn gets its answer there, whatever opened the
// turn (mail, a report, Orca): the thread mirrors the chat. Only the turn's Orca-raised question stays
// out of a receiver that can't mask it.
const PRIVATE = 'Private mail result'
const answersOf = (sent: ConnectorEvent[], turnId: number) =>
  sent.filter(
    (event): event is Extract<ConnectorEvent, { kind: 'turn-ended' }> =>
      event.kind === 'turn-ended' && event.turnId === turnId
  )

function receiver(capable: () => boolean) {
  const events = new ConnectorTurnEvents(dir, 'owner')
  const sent: ConnectorEvent[] = []
  const listen = (event: Parameters<ConnectorTurnEvents['observe']>[0]) => {
    events.useCloudFeatures(new Set(capable() ? ['prompts.audience'] : []))
    events.observe(event)
    const head = events.next(1)
    if (head) {
      sent.push(...head.batch)
      events.accepted(head.stamp)
    }
  }
  return { sent, listen }
}

it('posts a mail-started turn’s answer once a thread message joins it, never its question to an old receiver', async () => {
  const h = mailStartedBot('bot-chat', true)
  const wire = receiver(() => false)
  h.forward(wire.listen)
  const turns = h.create()
  h.joinDelivery()
  turns.observe(h.link.paneKey)
  turns.news({ kind: 'prompt', sessionId: 'session-1' })
  h.answer()
  turns.news({
    kind: 'turn-ended',
    sessionId: 'session-1',
    outcome: 'success',
    at: 600,
    readTurn: async () => ({
      lastAssistantMessage: 'Private mail result'
    })
  })
  h.publicTurn()
  turns.observe(h.link.paneKey)
  turns.news({
    kind: 'turn-ended',
    sessionId: 'session-1',
    outcome: 'success',
    at: 1000,
    readTurn: h.end('Public result')
  })
  await vi.waitFor(() =>
    expect(wire.sent).toContainEqual(
      expect.objectContaining({
        kind: 'turn-ended',
        turnId: 900,
        lastAssistantMessage: 'Public result'
      })
    )
  )
  expect(answersOf(wire.sent, 500)).toEqual([
    expect.objectContaining({ origin: 'delivery', lastAssistantMessage: PRIVATE })
  ])
  expect(wire.sent.filter((event) => event.kind === 'prompt')).toEqual([])
})

it.each(['watcher', 'host'] as const)(
  'posts an adopted turn’s answer once a thread message joins it after a downgrade and %s recreation',
  async (recreate) => {
    const h = mailStartedBot('bot-chat')
    let capable = true
    const wire = receiver(() => capable)
    h.forward(wire.listen)
    const original = h.create()
    original.news({ kind: 'prompt', sessionId: 'session-1' })
    expect(wire.sent).toContainEqual(
      expect.objectContaining({
        kind: 'prompt',
        prompt: expect.objectContaining({ raisedBy: 'orca' })
      })
    )
    h.answer()
    original.clear()
    capable = false
    h.setCapability(false)
    if (recreate === 'host') {
      h.restart()
    }
    const turns = h.create()
    turns.hears(h.link)
    h.joinDelivery()
    turns.delivered(h.link.paneKey, 'session-1')
    turns.news({
      kind: 'turn-ended',
      sessionId: 'session-1',
      outcome: 'success',
      at: 600,
      readTurn: async () => ({
        lastAssistantMessage: 'Private mail result'
      })
    })
    h.publicTurn()
    turns.observe(h.link.paneKey)
    turns.news({
      kind: 'turn-ended',
      sessionId: 'session-1',
      outcome: 'success',
      at: 1000,
      readTurn: h.end('Public result')
    })
    await vi.waitFor(() =>
      expect(wire.sent).toContainEqual(
        expect.objectContaining({
          kind: 'turn-ended',
          turnId: 900,
          lastAssistantMessage: 'Public result'
        })
      )
    )
    expect(answersOf(wire.sent, 500)).toEqual([
      expect.objectContaining({ origin: 'delivery', lastAssistantMessage: PRIVATE })
    ])
  }
)

it('posts a joined turn’s answer once when its chat rebinds and its watcher is recreated', async () => {
  const h = mailStartedBot('bot-chat')
  const wire = receiver(() => true)
  h.forward(wire.listen)
  const original = h.create()
  original.news({ kind: 'prompt', sessionId: 'session-1' })
  expect(wire.sent).toContainEqual(
    expect.objectContaining({
      kind: 'prompt',
      prompt: expect.objectContaining({ raisedBy: 'orca' })
    })
  )
  h.answer()
  h.joinDelivery()
  h.rebind()
  original.joined(h.link.paneKey, 'session-1')
  original.clear()
  const recreated = h.create()
  if (recreated.hears(h.link)) {
    recreated.adopt(h.link.paneKey)
  }
  recreated.news({
    kind: 'turn-ended',
    sessionId: 'session-1',
    outcome: 'success',
    at: 600,
    readTurn: async () => ({
      lastAssistantMessage: 'Private mail result'
    })
  })
  await vi.waitFor(() => expect(answersOf(wire.sent, 500)).toHaveLength(1))
  expect(wire.sent.filter((event) => event.kind === 'turn-ended')).toEqual([
    {
      kind: 'turn-ended',
      conversation: { source: 'slack', externalId: 'T1:B:U9' },
      paneKey: h.link.paneKey,
      turnId: 500,
      stopReason: 'success',
      at: 600,
      origin: 'delivery',
      lastAssistantMessage: PRIVATE
    }
  ])
})

it.each([false, true])(
  'posts a joined mail-started turn’s answer whether or not the host saw its question (host audience: %s)',
  async (hostCapable) => {
    const h = mailStartedBot('bot-chat', hostCapable, 'linear')
    const wire = receiver(() => false)
    h.forward(wire.listen)
    const turns = h.create()
    h.joinDelivery()
    turns.observe(h.link.paneKey)
    // A legacy hello filters the prompt before adoption; a capable host may miss the prompt edge.
    if (!hostCapable) {
      turns.news({ kind: 'prompt', sessionId: 'session-1' })
    }
    h.answer()
    turns.news({
      kind: 'turn-ended',
      sessionId: 'session-1',
      outcome: 'success',
      at: 600,
      readTurn: h.end('Private mail result')
    })
    h.publicTurn()
    turns.observe(h.link.paneKey)
    turns.news({
      kind: 'turn-ended',
      sessionId: 'session-1',
      outcome: 'success',
      at: 1000,
      readTurn: h.end('Public result')
    })
    await vi.waitFor(() =>
      expect(wire.sent).toContainEqual(
        expect.objectContaining({
          kind: 'turn-ended',
          turnId: 900,
          lastAssistantMessage: 'Public result'
        })
      )
    )
    expect(answersOf(wire.sent, 500)).toEqual([
      expect.objectContaining({ origin: 'delivery', lastAssistantMessage: PRIVATE })
    ])
    expect(wire.sent.filter((event) => event.kind === 'prompt')).toEqual([])
  }
)

it('tells a mail-started turn no one in the thread joined how it went, never what it said', async () => {
  const h = mailStartedBot('bot-chat')
  const wire = receiver(() => true)
  h.forward(wire.listen)
  const turns = h.create()
  turns.observe(h.link.paneKey)
  turns.news({ kind: 'prompt', sessionId: 'session-1' })
  h.answer()
  turns.news({
    kind: 'turn-ended',
    sessionId: 'session-1',
    outcome: 'success',
    at: 600,
    readTurn: h.end(PRIVATE)
  })
  await vi.waitFor(() => expect(answersOf(wire.sent, 500)).toHaveLength(1))
  expect(answersOf(wire.sent, 500)[0]).toMatchObject({ origin: 'local' })
  expect(answersOf(wire.sent, 500)[0]).not.toHaveProperty('lastAssistantMessage')
  expect(answersOf(wire.sent, 500)[0]).not.toHaveProperty('links')
})
