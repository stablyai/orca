// A refused queued card comes back as a returned card that holds the cards behind it, read from the
// chat's own rows with no card write of its own: through a rewind that retires its refused hand-off,
// a new epoch, a restart and a Resume. Only its own Send and Delete act on it.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig
const rewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['rewind']>>()

beforeEach(async () => {
  rewind.mockReset().mockResolvedValue({ ok: true })
  rig = await createQueuedMessageTestRig({ restartable: true, rewind })
})

afterEach(() => rig.dispose())

const journal = () => rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** The chat's queue rows on disk, in order. */
function queueRows(): { messageId: string; op: string }[] {
  return openTestJournalHostDatabase(rig.root)
    .db.prepare('SELECT row_json FROM journal_rows WHERE session_id = ? ORDER BY seq')
    .all(SESSION)
    .flatMap((row) => {
      const parsed: unknown =
        typeof row === 'object' && row !== null && 'row_json' in row
          ? JSON.parse(String(row.row_json))
          : null
      return typeof parsed === 'object' &&
        parsed !== null &&
        'kind' in parsed &&
        parsed.kind === 'queue' &&
        'messageId' in parsed &&
        'change' in parsed &&
        typeof parsed.change === 'object' &&
        parsed.change !== null &&
        'op' in parsed.change
        ? [{ messageId: String(parsed.messageId), op: String(parsed.change.op) }]
        : []
    })
}

/** Lets the drain run its steps; none may hand these cards off. */
async function expectNothingSent(...draftIds: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
}

async function sendTurn(text: string, turn: string): Promise<string> {
  const sent = rig.send(text)
  expect(await sent.result).toMatchObject({ ok: true })
  await eventually(async () => expect((await rig.submission(sent.id))?.handedOverAt).toBeDefined())
  await rig.settleAccepted(sent.id, turn)
  return agentJournalSubmissionKey(sent.id)
}

it('holds the cards behind it through a rewind, a new epoch, a restart and a Resume, until its own Send or Delete', async () => {
  const fields = { command: 'clear' as const }
  expect(
    await rig.host.conversationCommand(CALLER, {
      ...fields,
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  const target = await sendTurn('rewound away', 'target')
  const working = await rig.workingSend()
  const [a, b, c] = [await queuedDraft('A'), await queuedDraft('B'), await queuedDraft('C')]
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect((await rig.handoff(a))?.handedOverAt).toBeDefined())
  const refused = await rig.handoffId(a)
  await rig.settleRejected(refused, 'provider refused the card')
  const held = [
    { messageId: a, state: 'returned' },
    { messageId: b, state: 'waiting' },
    { messageId: c, state: 'waiting' }
  ]
  await eventually(async () => expect(await rig.drafts()).toEqual(held))
  // The refusal is the dispatch row alone: no card row records it.
  expect(queueRows()).toEqual([a, b, c].map((messageId) => ({ messageId, op: 'queued' })))

  // A rewind past the refused hand-off retires its submission; the card stays returned.
  const rewound = { itemId: target, expectedEpoch: journal().cursor().epoch }
  expect(
    await rig.host.rewind(CALLER, {
      ...rewound,
      envelope: rig.envelope(rewound, 'agentSession.rewind', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  expect(journal().submission(refused)).toBeUndefined()
  expect(await rig.drafts()).toEqual(held)
  await expectNothingSent(b, c)

  // A new epoch deletes the refusal's rows: it is restated with the card, and replay reads it.
  await journal().rollEpoch('handle_forked', rig.store.getRecord(SESSION)!.lease.runtimeFence)
  await rig.restartHostProcess()
  expect(await rig.drafts()).toEqual(held)
  await rig.resume()
  await expectNothingSent(b, c)
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page.ok && page.page.queuedMessages?.[0]?.returnedRejection).toMatchObject({
    kind: 'providerRejected'
  })

  // Its own Send hands it off under a fresh id; refused again, it holds the queue again.
  const resent = await rig.sendNow(a)
  if (!resent.ok || !('submission' in resent.value)) {
    throw new Error('expected the submission arm')
  }
  expect(resent.value.submission).toMatchObject({ queuedMessageId: a })
  await rig.settleRejected(resent.value.submission.clientMessageId, 'refused again')
  await eventually(async () => expect(await rig.drafts()).toEqual(held))
  await expectNothingSent(b, c)

  // Its own Delete releases the next card, in order.
  expect(await rig.deleteQueued(a)).toMatchObject({ ok: true, value: { deleted: true } })
  await eventually(async () => expect(await rig.handoff(b)).toBeDefined())
  expect(await rig.handoff(c)).toBeUndefined()
})
