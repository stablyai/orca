// The crash boundary: the host wrote a submission row, dispatched, and died
// before it learned whether the provider took the message. Replay must reconcile
// without duplicating the user's message and without losing it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { digestPayload } from './journal-payload-bounds'
import {
  reconcileSubmissions,
  type ProviderHistoryItem,
  type ProviderHistoryWindow
} from './journal-submission-reconciler'
import { openAgentSessionJournal } from './journal-store-factory'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const TURN_ID = '019fd8ca-edbe-7c43-b231-4c7aea3a2d89'

const ACCEPTED_IDENTITY: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: TURN_ID,
  ordinal: 0
}

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

async function open() {
  return openAgentSessionJournal({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
}

/** A Codex `userMessage` history item; `clientId` is the echoed client message id. */
function history(input: {
  itemId: string
  clientId: string | null
  text: string
  ordinal: number
}): ProviderHistoryItem {
  return {
    providerItemId: input.itemId,
    clientMessageId: input.clientId,
    payloadFingerprint: digestPayload(input.text),
    identity: { provider: 'codex', threadId: 'thread-1', turnId: TURN_ID, ordinal: input.ordinal }
  }
}

function window(
  items: ProviderHistoryItem[],
  overrides: Partial<ProviderHistoryWindow> = {}
): ProviderHistoryWindow {
  return { items, boundaryConsistent: true, turnInFlight: false, ...overrides }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-crash-'))
  clock = 1_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('crash between provider accept and journal commit', () => {
  it('reconciles the echo into the existing bubble instead of duplicating it', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_1',
      payloadFingerprint: digestPayload('deploy the thing'),
      body: userMessage('deploy the thing'),
      fence: 1
    })
    // Host dies here: the provider accepted, but no dispatch row was written.

    const restarted = await open()
    expect(restarted.pendingSubmissions().map((entry) => entry.clientMessageId)).toEqual(['cm_1'])
    await restarted.markPendingSubmissionsUnknown(2)
    expect(restarted.submissions()[0]?.dispatchState).toBe('unknown')

    const [outcome] = reconcileSubmissions({
      submissions: restarted.submissions(),
      history: window([
        history({ itemId: 'item-1', clientId: 'cm_1', text: 'deploy the thing', ordinal: 0 })
      ])
    })
    expect(outcome).toMatchObject({ outcome: 'accepted', providerItemId: 'item-1' })

    if (outcome?.outcome !== 'accepted') {
      throw new Error('expected the echoed submission to reconcile as accepted')
    }
    await restarted.resolveDispatch({
      clientMessageId: 'cm_1',
      state: 'accepted',
      providerIdentity: outcome.identity,
      fence: 2,
      recovered: true
    })
    // The provider's own copy of the message arrives next, under the identity
    // reconciliation adopted. It must land in the bubble the user already sees.
    await restarted.appendItem(outcome.identity, userMessage('deploy the thing'), { fence: 2 })

    const items = restarted.snapshot().items
    expect(items).toHaveLength(1)
    expect(items[0]?.itemId).toBe(agentJournalSubmissionKey('cm_1'))
    expect(restarted.receiptFor('cm_1')?.providerItemId).toBe(agentJournalItemKey(outcome.identity))
  })

  it('reports a rejected submission as never delivered, and never re-sends it', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_1',
      payloadFingerprint: digestPayload('never landed'),
      body: userMessage('never landed'),
      fence: 1
    })

    const restarted = await open()
    await restarted.markPendingSubmissionsUnknown(2)
    const [outcome] = reconcileSubmissions({
      submissions: restarted.submissions(),
      history: window([])
    })
    expect(outcome).toEqual({
      clientMessageId: 'cm_1',
      outcome: 'rejected',
      reason: 'not_delivered'
    })

    await restarted.resolveDispatch({
      clientMessageId: 'cm_1',
      state: 'rejected',
      reason: 'not_delivered',
      fence: 2,
      recovered: true
    })
    // The bubble survives with an explicit terminal state — the message is not
    // silently retried and not silently dropped.
    expect(restarted.snapshot().items).toHaveLength(1)
    expect(restarted.snapshot().submissions[0]?.dispatchState).toBe('rejected')
    expect(restarted.receiptFor('cm_1')).toBeNull()
  })

  it('survives replay of an already-reconciled journal without changing the answer', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_1',
      payloadFingerprint: digestPayload('once'),
      body: userMessage('once'),
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'cm_1',
      state: 'accepted',
      providerIdentity: ACCEPTED_IDENTITY,
      fence: 1
    })
    const settled = journal.snapshot()

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(settled)
    expect(reopened.pendingSubmissions()).toHaveLength(0)
    expect(
      reconcileSubmissions({ submissions: reopened.submissions(), history: window([]) })
    ).toEqual([])
  })

  it('keeps the receipt after the row that minted it was compacted away', async () => {
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      now: tick,
      mintEpoch: () => `epoch-${clock}`,
      compaction: { minTailRows: 1, retainTailMs: 0 }
    })
    await journal.appendSubmission({
      clientMessageId: 'cm_1',
      payloadFingerprint: digestPayload('kept'),
      body: userMessage('kept'),
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'cm_1',
      state: 'accepted',
      providerIdentity: ACCEPTED_IDENTITY,
      fence: 1
    })
    await journal.compact()

    const reopened = await open()
    expect(reopened.receiptFor('cm_1')?.providerItemId).toBe(agentJournalItemKey(ACCEPTED_IDENTITY))
  })
})

describe('reconciliation matching', () => {
  const submissions = [
    {
      clientMessageId: 'cm_1',
      fence: 1,
      payloadFingerprint: digestPayload('same text'),
      dispatchState: 'unknown' as const,
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    },
    {
      clientMessageId: 'cm_2',
      fence: 1,
      payloadFingerprint: digestPayload('same text'),
      dispatchState: 'unknown' as const,
      providerItemId: null,
      reason: null,
      submittedAt: 2,
      resolvedAt: null
    }
  ]

  it('matches each submission to its own echo when the provider carries client ids', () => {
    const outcomes = reconcileSubmissions({
      submissions,
      history: window([
        history({ itemId: 'item-1', clientId: 'cm_1', text: 'same text', ordinal: 0 }),
        history({ itemId: 'item-3', clientId: 'cm_2', text: 'same text', ordinal: 2 })
      ])
    })
    expect(outcomes).toEqual([
      expect.objectContaining({ clientMessageId: 'cm_1', providerItemId: 'item-1' }),
      expect.objectContaining({ clientMessageId: 'cm_2', providerItemId: 'item-3' })
    ])
  })

  it('refuses to guess between two identical payloads with no id to tell them apart', () => {
    const outcomes = reconcileSubmissions({
      submissions,
      history: window([
        history({ itemId: 'item-1', clientId: null, text: 'same text', ordinal: 0 }),
        history({ itemId: 'item-3', clientId: null, text: 'same text', ordinal: 2 })
      ])
    })
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['unknown', 'unknown'])
    expect(outcomes[0]).toMatchObject({ reason: 'ambiguous_match' })
  })

  it('uses a unique fingerprint only as a tiebreak when no id is echoed', () => {
    const [outcome] = reconcileSubmissions({
      submissions: [submissions[0]!],
      history: window([
        history({ itemId: 'item-1', clientId: null, text: 'same text', ordinal: 0 }),
        history({ itemId: 'item-2', clientId: null, text: 'something else', ordinal: 1 })
      ])
    })
    expect(outcome).toMatchObject({ outcome: 'accepted', providerItemId: 'item-1' })
  })

  it('never matches on text alone when the fingerprint disagrees', () => {
    const [outcome] = reconcileSubmissions({
      submissions: [submissions[0]!],
      history: window([
        {
          providerItemId: 'item-1',
          clientMessageId: null,
          payloadFingerprint: digestPayload('different payload, same rendered text'),
          identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 }
        }
      ])
    })
    expect(outcome).toMatchObject({ outcome: 'rejected', reason: 'not_delivered' })
  })

  it('lets a strong client-id match win an item a weaker fingerprint would have claimed', () => {
    const outcomes = reconcileSubmissions({
      submissions,
      history: window([
        history({ itemId: 'item-1', clientId: 'cm_2', text: 'same text', ordinal: 0 })
      ])
    })
    expect(outcomes).toEqual([
      expect.objectContaining({ clientMessageId: 'cm_1', outcome: 'rejected' }),
      expect.objectContaining({ clientMessageId: 'cm_2', providerItemId: 'item-1' })
    ])
  })

  it('re-matches a submission on the journal key it already adopted, not the raw provider id', () => {
    const [outcome] = reconcileSubmissions({
      submissions: [{ ...submissions[0]!, providerItemId: agentJournalItemKey(ACCEPTED_IDENTITY) }],
      history: window([
        // The provider renumbered its raw id; the identity-derived key did not move.
        history({ itemId: 'item-7', clientId: null, text: 'unrelated', ordinal: 0 })
      ])
    })
    expect(outcome).toMatchObject({ outcome: 'accepted', providerItemId: 'item-7' })
  })

  it('never hands one provider item to two submissions', () => {
    const outcomes = reconcileSubmissions({
      submissions: [
        { ...submissions[0]!, providerItemId: agentJournalItemKey(ACCEPTED_IDENTITY) },
        submissions[1]!
      ],
      // One item, wanted by both passes: cm_1 adopted its key, cm_2 is echoed on
      // it. Adopting it twice would render the same provider message twice.
      history: window([
        history({ itemId: 'item-7', clientId: 'cm_2', text: 'same text', ordinal: 0 })
      ])
    })
    expect(outcomes).toEqual([
      expect.objectContaining({ clientMessageId: 'cm_1', providerItemId: 'item-7' }),
      expect.objectContaining({ clientMessageId: 'cm_2', outcome: 'rejected' })
    ])
  })

  it('stays unknown when the history boundary cannot be trusted', () => {
    const [outcome] = reconcileSubmissions({
      submissions: [submissions[0]!],
      history: window([], { boundaryConsistent: false })
    })
    expect(outcome).toEqual({
      clientMessageId: 'cm_1',
      outcome: 'unknown',
      reason: 'history_boundary_inconsistent'
    })
  })

  it('stays unknown while a turn is still running', () => {
    const [outcome] = reconcileSubmissions({
      submissions: [submissions[0]!],
      history: window([], { turnInFlight: true })
    })
    expect(outcome).toEqual({
      clientMessageId: 'cm_1',
      outcome: 'unknown',
      reason: 'turn_in_flight'
    })
  })

  it('leaves settled submissions alone', () => {
    expect(
      reconcileSubmissions({
        submissions: [
          {
            ...submissions[0]!,
            dispatchState: 'accepted',
            providerItemId: agentJournalItemKey(ACCEPTED_IDENTITY)
          },
          { ...submissions[1]!, dispatchState: 'rejected' }
        ],
        history: window([])
      })
    ).toEqual([])
  })
})
