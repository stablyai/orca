// A Stop saved, then unable to take effect, is answered from its receipt, never rewritten: the
// failure is logged and the chat says the cancellation was not confirmed. "Couldn't stop" is only
// for a Stop that could not be saved. A card's own Cancel saves its receipt with the dismissal row,
// in one transaction, and one that cannot be saved says so about the card.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const CALLER_SCOPE = { kind: 'caller', callerKey: CALLER.callerKey } as const

let rig: QueuedMessageTestRig
let serial = 0
let warned: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rig.dispose()
})

function opId(): string {
  serial += 1
  return `${NOW}-${serial.toString(16).padStart(32, 'e')}`
}

function journal(): AgentSessionJournal {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function receipt(id: string) {
  return rig.store.readCommandReceipt(CALLER_SCOPE, id)
}

function statusTexts(): string[] {
  return journal()
    .snapshot()
    .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
}

/** The first `times` status rows written after the Stop is saved and the provider was asked fail. */
function failNotes(times = 1): () => void {
  const append = AgentSessionJournal.prototype.appendItem
  let left = times
  const failing = vi
    .spyOn(AgentSessionJournal.prototype, 'appendItem')
    .mockImplementation(async function (this: AgentSessionJournal, ...args) {
      if (args[1].kind === 'status' && left > 0) {
        left -= 1
        throw new Error('disk full')
      }
      return append.apply(this, args)
    })
  return () => failing.mockRestore()
}

it('answers a saved Stop from its receipt, notes it unconfirmed, and answers a retry the same', async () => {
  await rig.workingSend()
  const id = opId()
  const restore = failNotes()
  let answered: Awaited<ReturnType<QueuedMessageTestRig['stop']>>
  try {
    answered = await rig.stop(id)
  } finally {
    restore()
  }
  expect(answered).toMatchObject({ ok: true })
  expect(statusTexts()).toContain('Cancellation was not confirmed.')
  expect(receipt(id)).toMatchObject({ verdict: 'readable', receipt: { status: 'accepted' } })
  expect(warned.mock.calls.map((call) => String(call[0]))).toEqual(
    expect.arrayContaining([expect.stringContaining('a saved Stop failed to take effect')])
  )

  expect(await rig.stop(id)).toMatchObject({ ok: true, replayed: true })
  expect(rig.cancelTurn).toHaveBeenCalledOnce()
})

it('still answers from its receipt when the note cannot be written either, and logs both', async () => {
  await rig.workingSend()
  const id = opId()
  const restore = failNotes(2)
  try {
    expect(await rig.stop(id)).toMatchObject({ ok: true })
  } finally {
    restore()
  }
  expect(warned.mock.calls.map((call) => String(call[0]))).toEqual(
    expect.arrayContaining([expect.stringContaining("writing a failed Stop's note failed")])
  )
  expect(receipt(id)).toMatchObject({ verdict: 'readable', receipt: { status: 'accepted' } })
  expect(await rig.stop(id)).toMatchObject({ ok: true, replayed: true })
  expect(rig.cancelTurn).toHaveBeenCalledOnce()
})

describe("a card's own Cancel", () => {
  /** A question the live turn raised, which its provider dismisses on Cancel. */
  async function dismissibleCard(): Promise<{ itemId: string; revision: number }> {
    await rig.workingSend()
    await journal().appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 900 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1 },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const card = await journal().appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 901 },
      {
        kind: 'approval',
        title: 'Run the command?',
        detail: null,
        options: [{ id: 'allow', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    Object.assign(rig.host.deps.adapter, {
      routePromptCancel: () => ({ kind: 'dismiss' }),
      dismissPrompt: async (input: { commit: () => Promise<void> }) => input.commit()
    })
    return { itemId: card.itemId, revision: card.revision }
  }

  function cancelCard(card: { itemId: string; revision: number }, id: string) {
    const fields = {
      turnId: 'turn-1',
      prompt: { itemId: card.itemId, expectedRevision: card.revision }
    }
    return rig.host.cancel(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.cancel', id),
      ...fields
    })
  }

  function cardRow(itemId: string) {
    return journal()
      .snapshot()
      .items.find((item) => item.itemId === itemId)
  }

  it('saves its receipt with the dismissal row', async () => {
    const card = await dismissibleCard()
    const id = opId()

    expect(await cancelCard(card, id)).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(cardRow(card.itemId)?.body).toMatchObject({ resolution: { state: 'cancelled' } })
    // The dismissal is the last row written, and the receipt names it.
    const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
    const dismissal = since.ok ? since.rows.at(-1) : undefined
    expect(dismissal).toMatchObject({ kind: 'item' })
    expect(receipt(id)).toMatchObject({
      verdict: 'readable',
      receipt: { result: { kind: 'journal-row', sequence: dismissal?.seq } }
    })
    expect(rig.cancelTurn).not.toHaveBeenCalled()
  })

  it('dismisses nothing when its receipt cannot be saved', async () => {
    const card = await dismissibleCard()
    const id = opId()
    const db = openTestJournalHostDatabase(rig.root).db
    db.exec(`CREATE TRIGGER fail_cancel_receipt BEFORE INSERT ON agent_session_command_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
    try {
      expect(await cancelCard(card, id)).toMatchObject({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: 'cancelNotSaved' },
          message: "This question or approval wasn't cancelled."
        }
      })
    } finally {
      db.exec('DROP TRIGGER fail_cancel_receipt')
    }
    expect(cardRow(card.itemId)?.body).toMatchObject({ resolution: { state: 'pending' } })
    expect(receipt(id)).toEqual({ verdict: 'absent' })
  })
})
