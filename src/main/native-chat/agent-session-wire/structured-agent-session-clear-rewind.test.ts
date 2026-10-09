import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { recoverStructuredRewind } from './structured-rewind-recovery'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { queuePauseHolding } from '../agent-session-journal/queued-message-pause'

let rig: QueuedMessageTestRig
const rewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['rewind']>>()

beforeEach(async () => {
  rewind.mockReset().mockResolvedValue({ ok: true })
  rig = await createQueuedMessageTestRig({ restartable: true, rewind })
})
afterEach(() => rig.dispose())

const journal = () => rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
const db = () => openTestJournalHostDatabase(rig.root).db
const rawPrefix = (sequence: number) =>
  db()
    .prepare(
      'SELECT seq, row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq <= ? ORDER BY seq'
    )
    .all(SESSION, journal().cursor().epoch, sequence)

async function clear() {
  const fields = { command: 'clear' as const }
  const result = await rig.host.conversationCommand(CALLER, {
    ...fields,
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId())
  })
  expect(result).toMatchObject({ ok: true })
}

async function send(text: string, turn: string) {
  const sent = rig.send(text)
  expect(await sent.result).toMatchObject({ ok: true })
  await eventually(async () => expect((await rig.submission(sent.id))?.handedOverAt).toBeDefined())
  await rig.settleAccepted(sent.id, turn)
  return agentJournalSubmissionKey(sent.id)
}

async function seed() {
  const old = await send('before clear', 'old')
  await clear()
  const floor = journal().context.floor()!
  const prefix = journal()
    .snapshot()
    .items.filter((item) => item.sequence <= floor.sequence)
  const raw = rawPrefix(floor.sequence)
  const kept = await send('kept after clear', 'kept')
  const target = await send('rewound after clear', 'target')
  const fields = { itemId: target, expectedEpoch: journal().cursor().epoch }
  const params = {
    ...fields,
    envelope: rig.envelope(fields, 'agentSession.rewind', hostTestOperationId())
  }
  return { old, kept, target, floor, prefix, raw, params }
}

async function returnedCardAndWaitingCard() {
  const working = await rig.workingSend()
  const returned = rig.send('returned card', 'queue-if-active')
  const waiting = rig.send('waiting card', 'queue-if-active')
  expect(await returned.result).toMatchObject({ ok: true })
  expect(await waiting.result).toMatchObject({ ok: true })
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect((await rig.handoff(returned.id))?.handedOverAt).toBeDefined())
  await rig.stop()
  await rig.settleRejected(await rig.handoffId(returned.id), 'provider refused the card')
  await eventually(async () =>
    expect(await rig.drafts()).toEqual([
      { messageId: returned.id, state: 'returned' },
      { messageId: waiting.id, state: 'waiting' }
    ])
  )
  return { returned: returned.id, waiting: waiting.id }
}

async function replayedJournal() {
  const reopened = new AgentSessionJournal({
    database: openTestJournalHostDatabase(rig.root),
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: activeProviderContext(rig.store.getRecord(SESSION)!).head!.handle
    }
  })
  await reopened.open()
  return reopened
}

describe('rewind behind a clear boundary', () => {
  it.each(['stop', 'reopen'] as const)(
    'keeps a lifted %s pause lifted after suffix rewind and journal replay',
    async (pause) => {
      await clear()
      const { returned, waiting } = await returnedCardAndWaitingCard()
      if (pause === 'reopen') {
        await journal().appendQueueReopen(rig.store.getRecord(SESSION)!.lease.runtimeFence)
      }
      const target = await send('lifts the pauses', 'lift')
      expect(structuredQueuePauses(journal())).toEqual([])
      const fields = { itemId: target, expectedEpoch: journal().cursor().epoch }
      expect(
        await rig.host.rewind(CALLER, {
          ...fields,
          envelope: rig.envelope(fields, 'agentSession.rewind', hostTestOperationId())
        })
      ).toMatchObject({ ok: true })
      expect(structuredQueuePauses(journal())).toEqual([])
      expect((await replayedJournal()).queuedMessages.pauses()).toEqual([])
      expect(await rig.deleteQueued(returned)).toMatchObject({ ok: true })
      await eventually(async () => expect(await rig.handoff(waiting)).toBeDefined())
    }
  )

  it('keeps a later Stop active without holding cards queued after that Stop', async () => {
    await clear()
    const { waiting } = await returnedCardAndWaitingCard()
    await send('lifts the earlier stop', 'lift')
    const later = await rig.workingSend()
    await rig.stop()
    await rig.settleAccepted(later, 'stopped-later')
    const target = agentJournalSubmissionKey(later)
    const newer = await journal().queuedMessages.insert({
      messageId: 'queued-after-stop',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'newer card' }] },
      fingerprint: 'newer-card',
      hostInstance: 'test'
    })
    const originalPause = structuredQueuePauses(journal()).find(
      (entry) => entry.reason === 'stopped'
    )
    expect(originalPause).toBeDefined()
    const fields = { itemId: target, expectedEpoch: journal().cursor().epoch }
    expect(
      await rig.host.rewind(CALLER, {
        ...fields,
        envelope: rig.envelope(fields, 'agentSession.rewind', hostTestOperationId())
      })
    ).toMatchObject({ ok: true })
    expect(structuredQueuePauses(journal()).find((entry) => entry.reason === 'stopped')).toEqual(
      originalPause
    )
    expect(journal().queuedMessages.get(newer.messageId)?.queuedAt).toEqual(newer.queuedAt)
    expect(queuePauseHolding(structuredQueuePauses(journal()), newer)).toBeUndefined()
    const replayedPauses = (await replayedJournal()).queuedMessages.pauses()
    expect(replayedPauses.find((entry) => entry.reason === 'stopped')).toEqual(originalPause)
    expect(queuePauseHolding(replayedPauses, newer)).toBeUndefined()
    expect(queuePauseHolding(replayedPauses, journal().queuedMessages.get(waiting)!)?.reason).toBe(
      'stopped'
    )
    expect(await rig.handoff(waiting)).toBeUndefined()
  })

  it('rejects prefix and divider targets before acquiring or calling the provider', async () => {
    const old = await send('earlier', 'old')
    await clear()
    const marker = journal().snapshot().items.at(-1)!.itemId
    const starts = rig.starts.mock.calls.length
    for (const itemId of [old, marker]) {
      const fields = { itemId, expectedEpoch: journal().cursor().epoch }
      expect(
        await rig.host.rewind(CALLER, {
          ...fields,
          envelope: rig.envelope(fields, 'agentSession.rewind', hostTestOperationId())
        })
      ).toMatchObject({ ok: false, refusal: { rewindReason: 'invalid-target' } })
    }
    expect(rig.starts).toHaveBeenCalledTimes(starts)
    expect(rewind).not.toHaveBeenCalled()
  })

  it('rewrites only the suffix, retires its aliases, and keeps prefix bytes and epoch', async () => {
    const { old, target, floor, prefix, raw, params } = await seed()
    rewind.mockImplementationOnce(async () => {
      const prepared = rig.store.getRecord(SESSION)!.rewind!
      expect(prepared.contextClearOperationId).toBe(
        rig.store.getRecord(SESSION)!.providerContextBoundary!.operationId
      )
      expect(prepared.retained).toHaveLength(1)
      expect(prepared.retained[0].body).toMatchObject({
        kind: 'message',
        blocks: [{ text: 'kept after clear' }]
      })
      return { ok: true }
    })
    const result = await rig.host.rewind(CALLER, params)
    expect(result).toMatchObject({
      ok: true,
      value: { epoch: floor.epoch, sequence: journal().cursor().sequence }
    })
    expect(
      journal()
        .snapshot()
        .items.filter((item) => item.sequence <= floor.sequence)
    ).toEqual(prefix)
    expect(rawPrefix(floor.sequence)).toEqual(raw)
    expect(
      journal()
        .snapshot()
        .submissions.map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
    ).toEqual([old])
    expect(
      journal().canonicalItemId(rig.store.getRecord(SESSION)!.rewind!.providerItemId!)
    ).not.toBe(target)
    const reopened = await replayedJournal()
    expect(reopened.snapshot()).toEqual(journal().snapshot())
  })

  it('rolls suffix changes and success back together, then recovers once without provider retry', async () => {
    const { floor, raw, params } = await seed()
    const before = journal().snapshot()
    db().exec(`CREATE TEMP TRIGGER fail_rewind BEFORE UPDATE ON agent_session_records
      WHEN instr(NEW.record_json, '"phase":"completed"') > 0
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    await expect(rig.host.rewind(CALLER, params)).rejects.toThrow('disk full')
    expect(journal().snapshot()).toEqual(before)
    expect(rig.store.getRecord(SESSION)?.rewind?.phase).toBe('provider-succeeded')
    expect(
      rig.store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)?.outcome.status
    ).toBe('pending')
    db().exec('DROP TRIGGER fail_rewind')
    await recoverStructuredRewind(
      rig.host.deps,
      SESSION,
      journal(),
      rig.store.getRecord(SESSION)!.lease.runtimeFence
    )
    const recovered = journal().snapshot()
    await recoverStructuredRewind(
      rig.host.deps,
      SESSION,
      journal(),
      rig.store.getRecord(SESSION)!.lease.runtimeFence
    )
    expect(journal().snapshot()).toEqual(recovered)
    expect(rawPrefix(floor.sequence)).toEqual(raw)
    expect(rewind).toHaveBeenCalledOnce()
    expect(await rig.host.rewind(CALLER, params)).toMatchObject({ ok: true, replayed: true })
  })

  it('replays a lost suffix acknowledgment without rewriting or repeating the provider effect', async () => {
    const { params } = await seed()
    const original = journal().context.rewind.bind(journal().context)
    const lost = vi.spyOn(journal().context, 'rewind').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('lost acknowledgement')
    })
    await expect(rig.host.rewind(CALLER, params)).rejects.toThrow('lost acknowledgement')
    lost.mockRestore()
    const landed = journal().snapshot()
    expect(
      rig.store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)?.outcome.status
    ).toBe('succeeded')
    expect(await rig.host.rewind(CALLER, params)).toMatchObject({ ok: true, replayed: true })
    expect(journal().snapshot()).toEqual(landed)
    expect(rewind).toHaveBeenCalledOnce()
  })
})
