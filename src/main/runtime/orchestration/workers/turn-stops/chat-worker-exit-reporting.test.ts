import { afterEach, expect, it, vi } from 'vitest'
import { activeProviderContext } from '../../../../../shared/agent-session/conversation-context/agent-session-provider-context'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { AcpStructuredLane } from '../../../../acp/journal/acp-structured-lane'
import { OPENCODE_ACP_DIALECT } from '../../../../acp/acp-dialects/opencode-dialect'
import { recordingStructuredAgentSessionLogger } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_NOW as NOW } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { eventually } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { providerTimelineSink } from '../../../../native-chat/agent-session-timeline/provider-timeline-plan'
import { OrchestrationDb } from '../../db/orchestration-db'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { escalateChatWorkerError } from './chat-worker-error-escalation'
import { reportChatWorkerProviderDeath } from './chat-worker-provider-death'

const SESSION = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
let db: OrchestrationDb | undefined
let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  await rig?.dispose()
  db?.close()
  rig = undefined
  db = undefined
})

it.each(['journal ends first', 'journal error read fails', 'journal write is slow'] as const)(
  'wakes the coordinator once for an interrupted request when the %s',
  async (scenario) => {
    const database = new OrchestrationDb(':memory:')
    db = database
    const run = database.createRun({
      objective: 'collect a report',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
    })
    const task = database.createTask({ spec: 'inspect a file', runId: run.id })
    const dispatch = createRootDispatch(database, task.id, formatOrcaSessionAddress(SESSION))
    const notify = vi.fn()
    const deps = { getDb: () => database, notify, isWaitingForMail: () => false }
    const reports: Promise<void>[] = []
    const current = await createQueuedMessageTestRig({
      sessionId: SESSION,
      restartable: true,
      hostDeps: {
        onRequestFailure: (failure) => {
          const request =
            scenario === 'journal error read fails'
              ? { ...failure, read: () => Promise.reject(new Error('journal read unavailable')) }
              : failure
          reports.push(escalateChatWorkerError(request, deps))
        },
        onIdleProviderDeath: (death) => reportChatWorkerProviderDeath(death, deps)
      }
    })
    rig = current
    const { sessions, serialize } = current.host.collaboratorsForTests()
    await eventually(() => expect(sessions.get(SESSION)?.child?.phase).toBe('ready'))
    const session = sessions.get(SESSION)
    const child = session?.child
    if (!session || !child?.generation) {
      throw new Error('expected the attached provider')
    }
    const beforeExit = current.store.requireWritableRecord(SESSION)
    const linkedThread = activeProviderContext(beforeExit).head?.handle.nativeId

    const sink = providerTimelineSink(current.providerEvents())
    if (!sink) {
      throw new Error('expected a journal sink for the provider')
    }
    const lane = new AcpStructuredLane({
      sink,
      sessionId: SESSION,
      agent: 'codex',
      agentName: 'Worker',
      generation: child.generation,
      providerSessionId: 'fixture-thread',
      dialect: OPENCODE_ACP_DIALECT,
      logger: recordingStructuredAgentSessionLogger().logger,
      onInputAccepted: () => {},
      onFailed: (reason) => {
        throw new Error(reason)
      }
    })
    try {
      lane.apply([{ type: 'turn.open', turn: 'work', at: NOW - 100 }])
      await sink.written?.()
      expect((await session.journal.reads.runningRequest())?.turnState).toBe('running')
      const end = () =>
        lane.apply([{ type: 'session.ended', verdict: { state: 'interrupted', completedAt: NOW } }])
      if (scenario === 'journal ends first') {
        end()
        await sink.written?.()
      }
      const exit = {
        type: 'ended',
        sessionId: SESSION,
        cause: 'unexpected-exit',
        reason: 'provider process exited',
        fence: child.fence,
        acquisitionGeneration: child.generation,
        observedAt: NOW
      } as const
      if (scenario === 'journal write is slow') {
        let resumeWrite = () => {}
        const pending = new Promise<void>((resolve) => (resumeWrite = resolve))
        const appendSteps = session.journal.appendSteps.bind(session.journal)
        const delayedWrite = vi
          .spyOn(session.journal, 'appendSteps')
          .mockImplementationOnce(async (...args) => {
            await pending
            return appendSteps(...args)
          })
        try {
          end()
          const written = sink.written?.()
          const handled = current.host.handleAdapterEvent(exit)
          expect(database.getUnreadRunMailbox(run.id, 20, ['escalation'])).toHaveLength(0)
          resumeWrite()
          await Promise.all([written, handled])
        } finally {
          resumeWrite()
          delayedWrite.mockRestore()
        }
      } else {
        await current.host.handleAdapterEvent(exit)
      }
      await current.host.handleAdapterEvent(exit)
      await serialize(SESSION, async () => {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      await Promise.all(reports)
      expect(database.getUnreadRunMailbox(run.id, 20, ['escalation'])).toMatchObject([
        { subject: 'Worker stopped on an error without reporting' }
      ])
      expect(notify.mock.calls).toHaveLength(1)
      expect(database.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
      const record = current.store.requireWritableRecord(SESSION)
      const followUp = current.send('Continue the same task', undefined, {
        fence: record.lease.runtimeFence,
        internal: true
      })
      expect(await followUp.result).toMatchObject({ ok: true })
      await eventually(() => expect(sessions.get(SESSION)?.child?.phase).toBe('ready'))
      const resumed = sessions.get(SESSION)?.child
      expect(resumed?.fence).not.toBe(child.fence)
      expect(database.getDispatchContextById(dispatch.id)?.task_id).toBe(task.id)
      expect(
        activeProviderContext(current.store.requireWritableRecord(SESSION)).head?.handle.nativeId
      ).toBe(linkedThread)

      if (scenario === 'journal ends first' && resumed?.generation) {
        database.completeDispatch(dispatch.id)
        await current.host.handleAdapterEvent({
          ...exit,
          fence: resumed.fence,
          acquisitionGeneration: resumed.generation
        })
      } else {
        await current.host.close(SESSION, 'user-close')
      }
      await Promise.all(reports)
      expect(notify.mock.calls).toHaveLength(1)
      expect(database.getUnreadRunMailbox(run.id, 20, ['escalation'])).toHaveLength(1)
    } finally {
      lane.dispose()
    }
  }
)
