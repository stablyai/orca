import { expect, it } from 'vitest'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  createQueuedMessageTestRig,
  eventually
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { STRUCTURED_AGENT_SESSION_IDLE_MS as IDLE_MS } from './structured-agent-session-idle-sweep'

it('keeps a recovered handoff consumed through natural idle unload and a history reopen', async () => {
  let now = HOST_TEST_NOW
  const rig = await createQueuedMessageTestRig({
    restartable: true,
    now: () => now,
    idleSweep: { idleMs: IDLE_MS, intervalMs: 2_000_000_000 }
  })
  try {
    const first = await rig.workingSend()
    await rig.send('handed-over card', 'queue-if-active').result
    await rig.send('still waiting', 'queue-if-active').result
    const cards = await rig.drafts()
    const consumedId = cards[0]!.messageId
    const waitingId = cards[1]!.messageId
    await rig.settleAccepted(first, 'initial')
    await eventually(async () =>
      expect((await rig.handoff(consumedId))?.handedOverAt).toBeDefined()
    )
    const handoffId = await rig.handoffId(consumedId)
    const dispatches = rig.dispatch.mock.calls.length
    // Simulate process loss without a graceful close settling the handed-over row.
    rig.host.collaboratorsForTests().lifetime.idleSweep.dispose()
    rig.crashRestartHostProcess()
    const read = async () => {
      const result = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
      if (!result.ok) {
        throw new Error('history refused')
      }
      return result.page
    }
    const recovered = await read()
    expect(recovered.submissions.find((row) => row.clientMessageId === handoffId)).toMatchObject({
      queuedMessageId: consumedId,
      dispatchState: 'unknown',
      recovered: true
    })
    expect(recovered.queuedMessages?.map((card) => card.messageId)).toEqual([waitingId])
    const messages = () =>
      read().then((page) => projectStructuredAgentSessionMessages(page.items, [], page.submissions))
    const bubble = (await messages()).filter(
      (message) => message.id === agentJournalSubmissionKey(handoffId)
    )
    expect(bubble).toHaveLength(1)
    expect(bubble[0]?.unsent).toBeUndefined()
    expect(bubble[0]?.queued).toBeUndefined()
    now += IDLE_MS + 1
    await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(true)
    expect(await rig.deleteQueued(waitingId)).toMatchObject({ ok: true })
    now += IDLE_MS + 1
    await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
    const reopened = await read()
    expect(reopened.queuedMessages ?? []).toEqual([])
    expect(
      (await messages()).filter((message) => message.id === agentJournalSubmissionKey(handoffId))
    ).toEqual(bubble)
    expect(rig.dispatch).toHaveBeenCalledTimes(dispatches)
  } finally {
    await rig.dispose()
  }
})
