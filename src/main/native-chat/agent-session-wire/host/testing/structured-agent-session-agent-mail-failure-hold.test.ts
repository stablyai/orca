import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

// Another agent's mail waits behind a failed turn until the person sends; a bot request reads this
// to open a chat of its own instead of waiting there.
let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

async function held(): Promise<boolean> {
  return (await rig.host.conversation(SESSION)).journal.queuedMessages.failureHolds()
}

async function appendTurn(name: string, outcome: 'success' | 'failure'): Promise<void> {
  const journal = (await rig.host.conversation(SESSION)).journal
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `turn-${name}` },
    {
      kind: 'turn',
      turnId: name,
      providerTurnId: name,
      state: 'completed',
      outcome,
      startedAt: HOST_TEST_NOW,
      completedAt: HOST_TEST_NOW
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

describe("a chat's hold on another agent's mail", () => {
  it('holds it once the last turn failed, until a newer turn runs', async () => {
    expect(await held()).toBe(false)
    await appendTurn('finished', 'success')
    expect(await held()).toBe(false)
    await appendTurn('network-error', 'failure')
    expect(await held()).toBe(true)
    // A newer turn, which only the person's own send starts, recovers the chat.
    await appendTurn('recovered', 'success')
    expect(await held()).toBe(false)
  })
})
