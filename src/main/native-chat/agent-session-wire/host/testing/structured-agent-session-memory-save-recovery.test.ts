import { afterEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

/** A turn its opener started, cut by a usage limit. */
async function usageLimitedTurn(memorySave: boolean) {
  rig = await createQueuedMessageTestRig()
  const journal = (await rig.host.conversation(HOST_TEST_SESSION)).journal
  const fence = rig.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
  const opener = { provider: 'orca' as const, clientMessageId: 'opener' }
  await journal.appendItem(
    opener,
    {
      ...hostTestMessage('opener'),
      ...(memorySave ? { origin: 'memory-save' as const } : {})
    },
    { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const turn = { provider: 'orca' as const, clientMessageId: 'cut-turn' }
  await journal.appendItem(
    turn,
    {
      kind: 'turn',
      turnId: 'cut-turn',
      providerTurnId: 'cut-turn',
      state: 'completed',
      outcome: 'failure',
      userItemId: agentJournalItemKey(opener),
      startedAt: 1,
      completedAt: 2
    },
    { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'limit' },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 10 } }),
        { surface: 'row' }
      )
    },
    { fence, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) } }
  )
  return journal
}

it('a usage-limited ordinary turn is a cut Orca may continue (control)', async () => {
  const journal = await usageLimitedTurn(false)
  expect(await journal.reads.usageLimitCut()).toMatchObject({ resetsAt: 10 })
})

it('a usage-limited memory save is never continued', async () => {
  const journal = await usageLimitedTurn(true)
  expect(await journal.reads.usageLimitCut()).toBeNull()
})
