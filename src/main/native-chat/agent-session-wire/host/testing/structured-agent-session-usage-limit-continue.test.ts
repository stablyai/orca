import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { appendRewindUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW
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
