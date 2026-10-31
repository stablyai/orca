import { it, expect, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'

it('preserves existing queuedAt across two live replacements despite an older original receipt', async () => {
  const rewind = vi.fn(async () => ({ ok: true as const }))
  const rig = await createQueuedMessageTestRig({ restartable: true, rewind })
  try {
    const first = await rig.workingSend()
    await rig.settleAccepted(first, 'first')
    const second = rig.send('second rewind target')
    await second.result
    await eventually(async () =>
      expect((await rig.submission(second.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(second.id, 'second')
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const epoch1 = journal.epoch
    const original = journal.replaceEpochItems.bind(journal)
    const snapshots: unknown[] = []
    let command: Promise<unknown> | undefined, rewindAgain: Promise<unknown> | undefined
    const c = hostTestOperationId()
    const fields = { command: 'compact' as const, delivery: 'queue-if-active' as const }
    const capture = () => ({
      epoch: journal.epoch,
      submissions: journal.submissions().map((s) => ({
        id: s.clientMessageId,
        seq: s.acceptedSequence,
        handed: s.handedOverAt,
        state: s.dispatchState
      })),
      cards: journal.queuedMessages.list(),
      pauses: journal.queuedMessages.pauses()
    })
    vi.spyOn(journal, 'replaceEpochItems').mockImplementation(async (...args) => {
      snapshots.push(capture())
      const result = await original(...args)
      snapshots.push(capture())
      if (snapshots.length === 2) {
        // Real admissions queue before delivery resumes after the first replacement.
        command = rig.host.conversationCommand(CALLER, {
          ...fields,
          envelope: rig.envelope(fields, 'agentSession.conversationCommand', c),
          userSend: true
        })
        const target = journal
          .snapshot()
          .items.find(
            (item) =>
              item.body.kind === 'message' &&
              item.body.blocks.some(
                (block) => block.type === 'text' && block.text === 'work on this'
              )
          )!
        const next = { itemId: target.itemId, expectedEpoch: journal.epoch }
        rewindAgain = rig.host.rewind(CALLER, {
          ...next,
          envelope: rig.envelope(next, 'agentSession.rewind', hostTestOperationId())
        })
      }
      return result
    })
    const m = rig.send('M from E1')
    const cut = { itemId: agentJournalSubmissionKey(second.id), expectedEpoch: epoch1 }
    const rewound = rig.host.rewind(CALLER, {
      ...cut,
      envelope: rig.envelope(cut, 'agentSession.rewind', hostTestOperationId())
    })
    expect(await m.result).toMatchObject({ ok: true })
    expect(await rewound).toMatchObject({ ok: true })
    expect(await command).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    const secondVerdict = await rewindAgain
    expect(secondVerdict).toMatchObject({ ok: true })
    expect(snapshots).toHaveLength(4)
    const receipt = rig.store.readCommandReceipt({ kind: 'global' }, m.id)
    const card = journal.queuedMessages.get(c)!
    expect(receipt).toMatchObject({
      verdict: 'readable',
      receipt: {
        status: 'accepted',
        method: 'agentSession.send',
        sessionId: SESSION,
        result: { kind: 'journal-row', epoch: epoch1 }
      }
    })
    expect(card.queuedAt!.epoch).not.toBe(epoch1)
    expect(card.queuedAt!.epoch).toBe(journal.epoch)
    expect(card.queuedAt!.sequence).toBeGreaterThanOrEqual(
      journal.submission(m.id)!.acceptedSequence!
    )
    expect(journal.queuedMessages.pauses()).toEqual([])
    await eventually(async () => expect((await rig.submission(m.id))?.handedOverAt).toBeDefined())
    await rig.settleAccepted(m.id, 'M')
    await eventually(() => expect(rig.compact).toHaveBeenCalledTimes(1))
    const compact = rig.compact.mock.calls[0]![0].command
    rig.finishCompact()
    await eventually(() =>
      expect(journal.item(agentJournalItemKey(compact.identity))?.body).toMatchObject({
        kind: 'turn',
        state: 'completed'
      })
    )
    expect(await rig.submission(m.id)).toMatchObject({ dispatchState: 'accepted' })
  } finally {
    vi.restoreAllMocks()
    await rig.dispose()
  }
})
