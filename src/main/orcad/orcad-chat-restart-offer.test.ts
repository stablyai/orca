import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  CALLER,
  hostTestState
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW as NOW,
  hostTestAttachParams,
  hostTestOperationId
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { AgentSessionRecoveryCapsule } from '../runtime/agent-session/records/agent-session-recovery-capsule'
import { startOrcadWithLifecycle, stopOrcadStructuredAgentSessions } from './orcad-lifecycle'

vi.mock('../runtime/agent-session/structured-agent-session-runtime', () => ({
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
    const server = await startOrcadWithLifecycle(
      async (register) => {
        register(async () => {
          expect(
            (await new AgentSessionRecoveryCapsule(root).list(NOW))
              .map((row) => row.sessionId)
              .sort()
          ).toEqual([...ids].sort())
        })
        register(stopOrcadStructuredAgentSessions)
        return {}
      },
      async () => {}
    )
    await server.stop()
    await server.stop()
    expect(
      (await host.restartResume.list())
        .map(({ sessionId, trigger }) => ({ sessionId, trigger }))
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    ).toEqual(
      [...ids]
        .sort((left, right) => left.localeCompare(right))
        .map((sessionId) => ({ sessionId, trigger: 'quit' }))
    )
  }
)
