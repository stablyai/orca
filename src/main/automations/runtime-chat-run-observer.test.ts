import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { observeAutomationChatRun } from './observation/runtime-chat-run-observer'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { automationRunOperationId } from './launch/automation-run-operation'

const mocks = vi.hoisted(() => {
  const hostState: { actualHost: StructuredAgentSessionHost | null } = { actualHost: null }
  return {
    ...hostState,
    host: {
      automationRun: vi.fn(),
      observeConversationPublications: vi.fn(),
      queuedSendAnswer: vi.fn(async () => null)
    }
  }
})
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => mocks.actualHost ?? mocks.host
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actualHost = null
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('real host queue publication', () => {
  it('follows a queued run through handover and returns its exact output', async () => {
    const rig = await createQueuedMessageTestRig({ restartable: true })
    mocks.actualHost = rig.host
    const controller = new AbortController()
    try {
      const working = await rig.workingSend()
      const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
      const run = {
        ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
        // ast-grep-ignore: test-no-wall-clock -- Match the observer's expiry clock.
        createdAt: Date.now(),
        // ast-grep-ignore: test-no-wall-clock -- Match the observer's expiry clock.
        dispatchedAt: Date.now(),
        sessionKind: 'chat' as const,
        chatSessionId: HOST_TEST_SESSION
      }
      const q = automationRunOperationId(run, 'reuse-send')
      const fields = {
        body: hostTestMessage('automation behind human backlog'),
        delivery: 'queue-if-active' as const
      }
      expect(
        await rig.host.send(
          { callerKey: 'client-1' },
          {
            ...fields,
            envelope: rig.envelope(fields, 'agentSession.send', q)
          }
        )
      ).toMatchObject({ ok: true, value: { queued: { messageId: q, state: 'waiting' } } })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only runtime initialization and receipt lookup are scripted; the host owns delivery and observation.
      const runtime = {
        ensureStructuredAgentSessionHost: async () => {},
        openAgentSessionRecordStore: async () => ({
          getOperationRow: (_caller: string, id: string) =>
            id === q
              ? { outcome: { status: 'succeeded', sessionId: HOST_TEST_SESSION } }
              : undefined,
          getConversation: () => ({ provider: 'codex', location: { workspaceId: 'workspace-1' } })
        })
      } as unknown as OrcaRuntimeService
      const pending = observeAutomationChatRun(runtime, run, controller.signal)
      void pending.catch(() => {})
      await rig.settleAccepted(working, 'human')
      let sink = rig.providerEvents()
      sink.appendItem(
        { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-human', ordinal: 1 },
        { kind: 'turn', turnId: 'turn-human', state: 'completed', outcome: 'success' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
      )
      sink.publish({ lifecycle: true })
      expect(await sink.written?.()).toEqual({ ok: true })
      await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
      const sent = await vi.waitFor(() => rig.handoffId(q), { timeout: 10_000 })
      expect(sent).not.toBe(q)
      await eventually(async () =>
        expect((await journal.reads.submission(sent))?.handedOverAt).toBeDefined()
      )
      await rig.settleAccepted(sent, 'automation')
      const accepted = await journal.reads.submission(sent)
      sink = rig.providerEvents()
      const ownId = {
        provider: 'codex' as const,
        threadId: HOST_TEST_THREAD,
        turnId: 'turn-automation',
        ordinal: 1
      }
      sink.appendItem(
        ownId,
        {
          kind: 'turn',
          turnId: 'turn-automation',
          userItemId: accepted!.providerItemId!,
          state: 'completed',
          outcome: 'success'
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
      )
      sink.appendItem(
        { ...ownId, ordinal: 2 },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Exact automation output' }]
        },
        { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(ownId) } }
      )
      sink.publish({ lifecycle: true })
      expect(await sink.written?.()).toEqual({ ok: true })
      await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
      expect(await pending).toMatchObject({
        status: 'completed',
        outputSnapshot: { content: 'Exact automation output' }
      })
      expect(rig.dispatch).toHaveBeenCalledTimes(2)
    } finally {
      controller.abort()
      mocks.actualHost = null
      await rig.dispose()
    }
  })
})
