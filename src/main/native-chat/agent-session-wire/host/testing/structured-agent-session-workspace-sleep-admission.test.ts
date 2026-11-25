import { afterEach, expect, it } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

// An automatic release sleeps a worker's workspace only if the chat rests when Sleep reaches it in its lane.
let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

it('a chat mid-turn refuses an admitted workspace sleep in its own lane and keeps running', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  const workspaceId = rig.store.getRecord(SESSION)!.location.workspaceId
  const judged: string[] = []

  const result = await rig.host.sleepWorkspace(workspaceId, true, (sessionId, work) => {
    judged.push(`${sessionId}:${work.state}`)
    return false
  })

  expect(judged).toEqual([`${SESSION}:busy`])
  expect(result.stoppedSessionIds).toEqual([])
  expect(rig.store.getRecord(SESSION)?.sleptAt).toBeUndefined()
  expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeDefined()
})
