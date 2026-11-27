import { afterEach, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  eventually,
  KEPT_ENDED_GENERATION
} from './structured-agent-session-queued-message-rig-provider.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

// A kept agent that ended while Orca was closed is handed back once, to replay its output: the send
// waiting on it never reached it, so a fresh agent takes it exactly once, after that output.
it('hands a send queued on an ended kept agent to a fresh agent once, after its output', async () => {
  rig = await createQueuedMessageTestRig({ endedBeforeAcquire: true, restartable: true })
  const session = () => rig.host.collaboratorsForTests().sessions.get(SESSION)
  const dispatchedTo: (string | null | undefined)[] = []
  rig.dispatch.mockImplementation(async () => {
    dispatchedTo.push(session()?.child?.generation)
    return { state: 'admitted' as const }
  })
  const { id, result } = rig.send('after the restart')
  await result
  await eventually(() => expect(session()?.child?.phase).toBe('ready'))
  expect(session()?.child?.generation).toBe(KEPT_ENDED_GENERATION)
  const replayed = { provider: 'orca' as const, clientMessageId: 'replayed-output' }
  rig.providerEvents().appendLifecycleBatch!(
    'replayed-output',
    [
      {
        kind: 'item',
        identity: replayed,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'finished while closed' }]
        },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ],
    { lifecycle: true }
  )
  const { fence } = session()!.child!
  await rig.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    cause: 'unexpected-exit',
    reason: 'kept agent had exited',
    fence,
    acquisitionGeneration: KEPT_ENDED_GENERATION,
    observedAt: HOST_TEST_NOW,
    endedBeforeAcquire: true
  })
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
  expect(dispatchedTo).toEqual(['generation-1'])
  expect(rig.starts).toHaveBeenCalledTimes(2)
  expect((await rig.submission(id))?.rejection).toBeUndefined()
})

it('records no failed start when the ended kept agent closes while it opens', async () => {
  rig = await createQueuedMessageTestRig({
    endedBeforeAcquire: 'during-startup',
    restartable: true
  })
  const session = () => rig.host.collaboratorsForTests().sessions.get(SESSION)
  const { id, result } = rig.send('after the restart')
  await result
  await eventually(() => expect(session()?.child?.generation).toBe(KEPT_ENDED_GENERATION))
  // Its connection closed while it opened; the process exit follows.
  await rig.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    cause: 'unexpected-exit',
    reason: 'kept agent had exited',
    fence: session()!.child!.fence,
    acquisitionGeneration: KEPT_ENDED_GENERATION,
    observedAt: HOST_TEST_NOW,
    startupUnanswered: true,
    endedBeforeAcquire: true
  })
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
  expect(rig.starts).toHaveBeenCalledTimes(2)
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  const rows = page.ok ? page.page.items.map((item) => item.body.kind) : []
  expect(rows).not.toContain('status')
})
