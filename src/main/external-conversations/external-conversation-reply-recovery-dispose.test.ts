import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type {
  JournalConnectorReplyAdmit,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import type { EndedTurnReplies } from './external-conversation-reply-fill'
import { ConnectorReplyRecovery } from './external-conversation-reply-recovery'

// RR-C1-08: work recovery began before a dispose (another host, connectors off) writes, watches and
// schedules nothing once it resumes, at each boundary it awaits; a boot after it works as before.

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
const owed: JournalConnectorReplyRow = {
  account: 'account-a',
  deliveryId: 'd1',
  conversation: SLACK,
  sessionId: 'chat-1',
  epoch: 'e',
  messageId: 'm1',
  queued: false
}

/** A chat whose journal window reads wait until released; it counts opens and live watches. */
function heldChat(items: AgentJournalRenderItem[] = []) {
  const reads: (() => void)[] = []
  const chat = {
    opened: 0,
    subscribed: 0,
    live: 0,
    conversation: async () => {
      chat.opened += 1
      return {}
    },
    journalReads: async () => ({
      canonicalItemIds: async (ids: readonly string[]) =>
        ids.map((itemId) => ({ itemId, canonicalItemId: itemId })),
      operationWindow: () =>
        new Promise((resolve) =>
          reads.push(() =>
            resolve({
              snapshot: {
                sessionId: 'chat-1',
                cursor: { epoch: 'e', sequence: 9 },
                items,
                submissions: []
              },
              complete: true
            })
          )
        )
    }),
    observeJournalPublications: () => {
      chat.subscribed += 1
      chat.live += 1
      return () => {
        chat.live -= 1
      }
    }
  }
  return { chat, release: () => reads.splice(0).forEach((resolve) => resolve()) }
}

/** Recovery over one owed row; `bootRead` holds the boot's first, journal-wide read until released.
 *  Its writes record whether their admit let them through when they reached the writer. */
function recoveryOver(
  current: () => ReturnType<typeof heldChat>['chat'],
  options: {
    bootRead?: Promise<void>
    fillTurn?: (turn: EndedTurnReplies, journal: ConnectorReplyCutJournal) => Promise<void>
  } = {}
) {
  const writes: boolean[] = []
  const filled = vi.fn()
  const journal: Pick<
    ConnectorReplyCutJournal,
    'read' | 'fillOutcomes' | 'fillEach' | 'probeExpired' | 'cut' | 'recut'
  > = {
    read: async (sessionId) => {
      if (sessionId === undefined) {
        await options.bootRead
      }
      return [owed]
    },
    fillOutcomes: async (_fills, admit?: JournalConnectorReplyAdmit) => {
      writes.push(admit?.() !== false)
      return false
    },
    fillEach: async (fills, admit?: JournalConnectorReplyAdmit) => {
      writes.push(admit?.() !== false)
      return fills.map(() => false)
    },
    probeExpired: async (keys) => keys.map(() => null),
    cut: async () => false,
    recut: async () => false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery reads, fills and cuts only.
  const full = journal as ConnectorReplyCutJournal
  const recovery = new ConnectorReplyRecovery({
    journal: () => full,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery calls only these chat members.
    chat: () => current() as never,
    hasSession: () => true,
    isBot: () => false,
    agentOf: () => 'claude',
    fillTurn: async (turn) => {
      await options.fillTurn?.(turn, full)
      return { covered: new Set(), paused: false }
    },
    filled,
    continuationsSettled: Promise.resolve()
  })
  return { recovery, writes, filled }
}

it('leaves no watch or timer on the old host when its pending read returns after a host change', async () => {
  const old = heldChat()
  const next = heldChat()
  let current = old.chat
  const { recovery, writes } = recoveryOver(() => current)
  const booting = recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  recovery.dispose()
  current = next.chat
  old.release()
  await booting
  expect([old.chat.subscribed, old.chat.live, vi.getTimerCount(), writes]).toEqual([0, 0, 0, []])
  // The new host's boot works as before: its owed row is watched there.
  const rebooting = recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  next.release()
  await rebooting
  expect([next.chat.subscribed, next.chat.live]).toEqual([1, 1])
})

it('leaves no watch or timer when connectors stop while the read is pending', async () => {
  const held = heldChat()
  const { recovery } = recoveryOver(() => held.chat)
  const booting = recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  recovery.dispose()
  held.release()
  await booting
  await vi.advanceTimersByTimeAsync(5_000)
  expect([held.chat.subscribed, held.chat.live, vi.getTimerCount()]).toEqual([0, 0, 0])
})

it('starts no pass from a boot whose first read returns after a dispose', async () => {
  const held = heldChat()
  const gate = Promise.withResolvers<void>()
  const { recovery, filled } = recoveryOver(() => held.chat, { bootRead: gate.promise })
  void recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  recovery.dispose()
  gate.resolve()
  await vi.advanceTimersByTimeAsync(5_000)
  expect([held.chat.opened, held.chat.subscribed, filled.mock.calls.length]).toEqual([0, 0, 0])
})

it('drops the write of a fill nested in a pass when a dispose comes while it awaits', async () => {
  const message: AgentJournalRenderItem = {
    itemId: 'm1',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'fix it' }],
      connectorDelivery: { account: 'account-a', conversation: SLACK, deliveryId: 'd1' }
    }
  }
  const turn: AgentJournalRenderItem = {
    itemId: 'item:t1',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'turn', turnId: 't1', state: 'completed', outcome: 'success', userItemId: 'm1' }
  }
  const held = heldChat([message, turn])
  const inFill = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const { recovery, writes } = recoveryOver(() => held.chat, {
    fillTurn: async (ended, journal) => {
      inFill.resolve()
      await proceed.promise
      await journal.fillOutcomes(
        [{ account: 'account-a', deliveryId: 'd1', outcome: 'answered', answerDeliveryId: 'd1' }],
        ended.current
      )
    }
  })
  const booting = recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  held.release()
  await inFill.promise
  recovery.dispose()
  proceed.resolve()
  await booting
  expect([writes, held.chat.subscribed, vi.getTimerCount()]).toEqual([[false], 0, 0])
})

it('opens the chat first when a boot asks while a pass that did not open it still runs', async () => {
  const held = heldChat()
  const { recovery } = recoveryOver(() => held.chat)
  recovery.turnEnded('chat-1')
  await vi.advanceTimersByTimeAsync(2_000)
  const booting = recovery.boot()
  // Each pass's window read is released as it comes: the running one, then the one run again.
  for (let read = 0; read < 4; read += 1) {
    await vi.advanceTimersByTimeAsync(0)
    held.release()
  }
  await booting
  expect(held.chat.opened).toBe(1)
})

it('schedules nothing for a turn end that arrives after connectors stop', async () => {
  const held = heldChat()
  const { recovery } = recoveryOver(() => held.chat)
  recovery.dispose()
  recovery.turnEnded('chat-1')
  recovery.admitted('chat-1')
  expect([vi.getTimerCount(), held.chat.subscribed]).toEqual([0, 0])
})

it('runs no pass a boot asked for again once a dispose came before the running pass ended', async () => {
  const held = heldChat()
  const { recovery } = recoveryOver(() => held.chat)
  recovery.turnEnded('chat-1')
  await vi.advanceTimersByTimeAsync(2_000)
  // A boot asks for the chat opened while that pass reads; connectors stop before it ends.
  void recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  recovery.dispose()
  for (let read = 0; read < 4; read += 1) {
    held.release()
    await vi.advanceTimersByTimeAsync(0)
  }
  await vi.advanceTimersByTimeAsync(5_000)
  expect([held.chat.opened, held.chat.subscribed, vi.getTimerCount()]).toEqual([0, 0, 0])
})
