import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  appendRewindUsageLimitedTurn,
  appendUsageLimitedTurn
} from './structured-agent-session-rewind-usage-limit.test-fixture'
import { RestartContinuationSupersededError } from '../../recovery/structured-agent-session-restart-continuation'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { StructuredAgentSessionUsageLimitContinue } from '../../recovery/structured-agent-session-usage-limit-continue'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW,
  hostTestRestingOptionsRecord
} from './structured-agent-session-host-test-data'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

it('automatically continues a failed usage-limited turn after its reset instead of queueing behind it', async () => {
  let clock = HOST_TEST_NOW
  rig = await createQueuedMessageTestRig({
    now: () => clock,
    usageLimitAutoContinue: {
      isEnabled: () => true,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {}
    }
  })
  const current = rig
  await current.store.setSessionTabVisibility(SESSION, true)
  const journal = current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const cut = await appendRewindUsageLimitedTurn(journal, clock)
  clock = cut.resetsAt + 15_000
  await current.host.usageLimitContinue.tick()
  let continuationId: string | undefined
  await eventually(async () => {
    const snapshot = await current.host.journalSnapshot(SESSION)
    continuationId = snapshot.submissions.find(
      (submission) => submission.handedOverAt !== undefined
    )?.clientMessageId
    expect(continuationId).toBeDefined()
  })
  await current.settleAccepted(continuationId!, 'continued')
  expect((await current.submission(continuationId!))?.dispatchState).toBe('accepted')
  expect(await current.drafts()).toEqual([])
  expect(await current.queuePause()).toBeNull()
})

it('stops automatically continuing once five continues in a row end in another usage limit', async () => {
  let clock = HOST_TEST_NOW
  rig = await createQueuedMessageTestRig({
    now: () => clock,
    usageLimitAutoContinue: {
      isEnabled: () => true,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {}
    }
  })
  const current = rig
  await current.store.setSessionTabVisibility(SESSION, true)
  const journal = current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  let cut = await appendRewindUsageLimitedTurn(journal, clock)
  const sent: string[] = []
  for (let round = 0; round < 8; round += 1) {
    clock = cut.resetsAt + 15_000
    await current.host.usageLimitContinue.tick()
    const snapshot = await current.host.journalSnapshot(SESSION)
    const continuation = snapshot.submissions.find(
      (submission) => submission.origin === 'host' && !sent.includes(submission.clientMessageId)
    )
    if (!continuation) {
      break
    }
    sent.push(continuation.clientMessageId)
    await current.settleAccepted(continuation.clientMessageId, `continued-${round}`)
    const accepted = await current.submission(continuation.clientMessageId)
    // Claude's echo opens a turn under the provider's item; output-first turns key the submission.
    const userItemId =
      round % 2 === 1 && accepted?.providerItemId
        ? accepted.providerItemId
        : agentJournalSubmissionKey(continuation.clientMessageId)
    cut = await appendUsageLimitedTurn(journal, clock, `refail-${round}`, userItemId)
  }
  expect(sent).toHaveLength(5)
  expect(current.host.usageLimitContinue.readState(SESSION)?.state).toBe('failed')
})

it('continues every chat whose limit reset in the same pass', async () => {
  const now = HOST_TEST_NOW
  const ids = ['chat-a', 'chat-b', 'chat-c']
  const cut = (id: string) => ({
    turnItemId: `${id}-turn`,
    resetsAt: now - 60_000,
    turnEndedAt: now - 120_000,
    chain: 0
  })
  const sent: string[] = []
  const sweep = new StructuredAgentSessionUsageLimitContinue({
    host: {
      logger: recordingStructuredAgentSessionLogger().logger,
      usageLimitAutoContinue: {
        isEnabled: () => true,
        isWorkspaceAsleep: () => false,
        subscribe: () => () => {}
      },
      store: {
        hostId: 'local',
        listVisibleSessionIds: () => ids,
        isSessionTabVisible: () => true,
        cancelUsageLimitContinue: async (id) => hostTestRestingOptionsRecord(id),
        getRecord: (id) => hostTestRestingOptionsRecord(id)
      }
    },
    sessions: new Map(ids.map((id) => [id, {}])),
    readSavedCut: () => null,
    readLoadedCut: cut,
    serialize: (_id, run) => run(),
    // Each send is answered as superseded, which spends no budget; only who was sent matters here.
    send: async (params) => {
      params.beforeRun?.()
      sent.push(params.envelope.sessionId)
      throw new RestartContinuationSupersededError()
    },
    publish: () => {},
    now: () => now
  })
  await sweep.tick()
  expect(sent).toEqual(ids)
})
