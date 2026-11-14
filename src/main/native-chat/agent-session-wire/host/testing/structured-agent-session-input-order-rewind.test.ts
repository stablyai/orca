import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { it, expect, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'

it('preserves queued command placement across two rewinds and later send settlement', async () => {
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
    const epoch1 = (await journal.reads.cursor()).epoch
    const original = journal.completeRewind.bind(journal)
    let repeated = false
    let command: Promise<unknown> | undefined, rewindAgain: Promise<unknown> | undefined
    const c = hostTestOperationId()
    const fields = { command: 'compact' as const, delivery: 'queue-if-active' as const }
    vi.spyOn(journal, 'completeRewind').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (!repeated) {
        repeated = true
        // Real admissions queue before delivery resumes after the first replacement.
        command = rig.host.conversationCommand(CALLER, {
          ...fields,
          envelope: rig.envelope(fields, 'agentSession.conversationCommand', c),
          userSend: true
        })
        const target = (await readTestJournalItems(journal)).find(
          (item) =>
            item.body.kind === 'message' &&
            item.body.blocks.some((block) => block.type === 'text' && block.text === 'work on this')
        )!
        const next = { itemId: target.itemId, expectedEpoch: (await journal.reads.cursor()).epoch }
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
    const card = (await journal.queuedMessages.get(c))!
    expect(card.queuedAt!.epoch).toBe(epoch1)
    expect(card.queuedAt!.sequence).toBeGreaterThanOrEqual(
      (await journal.reads.submission(m.id))!.acceptedSequence!
    )
    expect(await journal.queuedMessages.pauses()).toEqual([])
    await eventually(async () => expect((await rig.submission(m.id))?.handedOverAt).toBeDefined())
    await rig.settleAccepted(m.id, 'M')
    await eventually(() => expect(rig.compact).toHaveBeenCalledTimes(1))
    const compact = rig.compact.mock.calls[0]![0].command
    rig.finishCompact()
    await eventually(async () =>
      expect((await journal.reads.item(agentJournalItemKey(compact.identity)))?.body).toMatchObject(
        {
          kind: 'turn',
          state: 'completed'
        }
      )
    )
    expect(await rig.submission(m.id)).toMatchObject({ dispatchState: 'accepted' })
  } finally {
    vi.restoreAllMocks()
    await rig.dispose()
  }
})
