import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  CALLER,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW as NOW,
  hostTestAttachParams,
  hostTestOperationId
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AgentSessionRecoveryCapsule } from '../runtime/agent-session-recovery-capsule'
import { startOrcadWithLifecycle, stopOrcadStructuredAgentSessions } from './orcad-lifecycle'

vi.mock('../runtime/structured-agent-session-runtime', () => ({
  stopStructuredAgentSessionRuntime: async (options: { trigger: 'quit' }) => {
    await hostTestState().host.flushAllStreamedEvents(options)
  }
}))

afterEach(() => vi.restoreAllMocks())

it.each([10, 100])(
  'batches %i working chats into durable offers before the profile closes',
  async (size) => {
    const { host, acquire, root } = hostTestState()
    const ids = Array.from({ length: size }, (_, i) => `session-${i}`)
    for (const sessionId of ids) {
      const params = hostTestAttachParams(null, {
        envelope: {
          sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: ''
        }
      })
      expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
      const events = acquire.mock.calls.at(-1)?.[0].events
      if (!events) {
        throw new Error('missing provider event sink')
      }
      events.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
        { kind: 'turn', turnId: 'working', state: 'running' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await host.flushStreamedEvents(sessionId)
    }
    const close = vi.fn(async () => true)
    host.deps.adapter.closeSession = close
    const record = vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'record')
    const getRecord = vi.spyOn(host.deps.store, 'getRecord')
    const server = await startOrcadWithLifecycle(
      async (register) => {
        register(async () => {
          expect(close.mock.calls).toEqual(ids.map((id) => [id]))
          expect(record).toHaveBeenCalledTimes(1)
          expect(record.mock.calls[0]?.[0]).toHaveLength(size)
          expect(
            (await new AgentSessionRecoveryCapsule(root).list(NOW)).map((row) => row.sessionId)
          ).toEqual(ids)
        })
        register(stopOrcadStructuredAgentSessions)
        return {}
      },
      async () => {}
    )
    await server.stop()
    // Witness, lease and status passes are per session; no inventory scan for each child.
    expect(getRecord.mock.calls.length).toBeLessThanOrEqual(32 * size)
    const reads = getRecord.mock.calls.length
    await server.stop()
    expect(getRecord).toHaveBeenCalledTimes(reads)
    expect(close).toHaveBeenCalledTimes(size)
    expect(record).toHaveBeenCalledTimes(1)
    record.mockRestore()
    getRecord.mockRestore()
    expect(await host.restartResume.list()).toMatchObject(
      ids.map((sessionId) => ({ sessionId, trigger: 'quit' }))
    )
  }
)
