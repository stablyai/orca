import { afterEach, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

async function steer(text: string): Promise<string> {
  const result = await rig.send(text).result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error(`expected a steer card, got ${JSON.stringify(result)}`)
  }
  return result.value.queued.messageId
}

// #42706: Claude takes a steer in only at its next tool boundary, so A stays unechoed for minutes.
it('a second steer joins the running turn while the first is still unechoed', async () => {
  rig = await createQueuedMessageTestRig()
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'working')
  await rig.host
    .collaboratorsForTests()
    .sessions.get(SESSION)!
    .journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-of-working', ordinal: 0 },
      {
        kind: 'turn',
        turnId: 'turn-of-working',
        startedAt: HOST_TEST_NOW,
        userItemId: agentJournalSubmissionKey(working),
        state: 'running'
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

  const first = await steer('also check the logs')
  await eventually(async () => expect((await rig.handoff(first))?.handedOverAt).toBeDefined())
  const second = await steer('and keep the old flag')

  await eventually(async () => expect((await rig.handoff(second))?.handedOverAt).toBeDefined())
  expect((await rig.handoff(first))?.dispatchState).toBe('pending')
  const order = rig.dispatch.mock.calls.map(([input]) => input.clientMessageId)
  expect(order.slice(-2)).toEqual([await rig.handoffId(first), await rig.handoffId(second)])
})
