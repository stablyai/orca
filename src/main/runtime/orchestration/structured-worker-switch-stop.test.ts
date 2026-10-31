import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { captureStructuredWorkerSwitchStop } from './structured-worker-switch-stop'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_SESSION as id,
  REST_TEST_CALLER as caller,
  REST_TEST_THREAD,
  type RestTestRig
} from '../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { STOP_NOTE_CANCELLATION_REQUESTED } from '../../native-chat/agent-session-wire/structured-agent-session-turn-stop-notes'

let rig: RestTestRig
let db: OrchestrationDb
let deadline: ReturnType<typeof agentSessionSwitchDeadline>
const forgetStructuredSessionMail = vi.fn()
beforeEach(async () => {
  db = new OrchestrationDb(':memory:')
  deadline = agentSessionSwitchDeadline()
  forgetStructuredSessionMail.mockClear()
  rig = await createRestTestRig({
    captureSessionSwitchStop: (sessionId) =>
      captureStructuredWorkerSwitchStop(sessionId, db, 'test-runtime', {
        forgetStructuredSessionMail
      })
  })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  deadline.dispose()
  await rig.dispose()
  db.close()
})

it.each([false, true])(
  'settles worker Stop only after proven physical exit=%s and releases ordinary mail redrive',
  async (proven) => {
    await foundRestTestChat(rig)
    const identity = structuredWorkerIdentities.register({
      handle: mintStructuredWorkerHandle(),
      sessionId: id,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(id),
      processIncarnation: structuredWorkerProcessIncarnation(id),
      worktreeId: 'workspace',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'Captured worker turn' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: identity.handle,
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation,
      worktreeId: identity.worktreeId,
      effects: [],
      setupState: 'not_configured',
      hostScope: JSON.stringify(identity.hostScope),
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(dispatch.id)
    const entered = Promise.withResolvers<void>()
    const exit = Promise.withResolvers<boolean>()
    const close = rig.adapter.closeSession.getMockImplementation()!
    rig.adapter.closeSession.mockImplementation(async (...args) => {
      entered.resolve()
      return (await exit.promise) ? close(...args) : false
    })
    const stopping = rig.host.stopForSwitch(id, caller, deadline)
    const observed = stopping.then(
      () => true,
      () => false
    )
    await entered.promise
    exit.resolve(proven)
    expect(await observed).toBe(proven)
    expect(db.getWorkerDispatch(dispatch.id)?.state).toBe(proven ? 'stopped' : 'stop_unknown')
    expect(forgetStructuredSessionMail).toHaveBeenCalledWith(id)
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe(proven ? 'failed' : 'dispatched')
  }
)

it.each([false, true])(
  'sends the switch’s Stop only to a chat that is replying=%s, so an idle chat gets no Stop note',
  async (replying) => {
    await foundRestTestChat(rig)
    const events = rig.adapter.acquire.mock.calls.at(-1)![0].events
    for (const state of replying ? (['running'] as const) : (['running', 'completed'] as const)) {
      events.appendItem(
        { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'turn', ordinal: 50 },
        { kind: 'turn', turnId: 'turn', state },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    await rig.host.flushStreamedEvents(id)
    const cancel = vi.spyOn(rig.host, 'cancel')
    await rig.host.stopForSwitch(id, caller, deadline)
    expect(cancel).toHaveBeenCalledTimes(replying ? 1 : 0)
    const { journal } = await rig.host.collaboratorsForTests().lifetime.conversation(id)
    expect(
      JSON.stringify(journal.snapshot().items).includes(STOP_NOTE_CANCELLATION_REQUESTED)
    ).toBe(replying)
  }
)
