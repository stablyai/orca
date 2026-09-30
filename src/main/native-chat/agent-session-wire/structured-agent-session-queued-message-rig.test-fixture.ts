// One real-host rig for the mid-turn queue suites: store, journal, adapter
// mocks, and the send/stop/draft helpers every suite shares.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuePause } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { rotateStructuredAgentSessionHostInstanceForTests } from './structured-agent-session-queued-pause'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'

export const QUEUED_RIG_CALLER = { callerKey: 'client-1' }

export function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

export type QueuedMessageTestRig = Awaited<ReturnType<typeof createQueuedMessageTestRig>>

export async function createQueuedMessageTestRig() {
  const root = await mkdtemp(join(tmpdir(), 'orca-queued-messages-'))
  resetHostTestOperationIds()
  // Admitted: the message is written and unanswered, so the session owes work
  // until the test settles it.
  const dispatch: Mock<StructuredAgentSessionAdapter['dispatch']> = vi.fn(async () => ({
    state: 'admitted' as const
  }))
  const awaitStarted: Mock<NonNullable<StructuredAgentSessionAdapter['awaitStarted']>> = vi.fn(
    async () => undefined
  )
  // The provider's receipt of a /compact; its end arrives later, as `finishCompact` writes it.
  const compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>> = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: null
  }))
  let events: StructuredAgentSessionEventSink | undefined
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: async ({ fence, spawnToken, events: sink }) => {
        events = sink
        return {
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken
          },
          acquisitionGeneration: 'generation-1',
          link: {
            linkId: `link-${fence}`,
            handle: { provider: 'codex' as const, threadId: THREAD },
            origin: 'created' as const,
            mintedAtFence: fence,
            observedAt: NOW
          }
        }
      },
      dispatch,
      awaitStarted,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      compact,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(QUEUED_RIG_CALLER, hostTestAttachParams(null))).toMatchObject({
    ok: true
  })

  function envelope(
    fields: Record<string, unknown>,
    method: string,
    clientOperationId: string,
    sessionId = SESSION
  ) {
    return {
      sessionId,
      clientOperationId,
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method,
        sessionId,
        fields
      })
    }
  }

  /** A client's send, as the `agentSession.send` RPC hands it to the host;
   *  `internal` is a host-side sender (orchestration mail, a restart continuation). */
  function send(text: string, delivery?: 'queue-if-active', options?: { internal?: true }) {
    const body = hostTestMessage(text)
    const clientOperationId = hostTestOperationId()
    const fields = { body, ...(delivery ? { delivery } : {}) }
    const result = host.send(QUEUED_RIG_CALLER, {
      envelope: envelope(fields, 'agentSession.send', clientOperationId),
      body,
      ...(delivery ? { delivery } : {}),
      ...(options?.internal ? {} : { userSend: true as const })
    })
    return { id: clientOperationId, result }
  }

  function stop(clientOperationId = hostTestOperationId(), caller = QUEUED_RIG_CALLER) {
    return host.cancel(caller, {
      envelope: envelope({}, 'agentSession.cancel', clientOperationId)
    })
  }

  function sendNow(
    messageId: string,
    clientOperationId = hostTestOperationId(),
    sessionId = SESSION
  ) {
    return host.queuedMessageSend(QUEUED_RIG_CALLER, {
      envelope: envelope(
        { messageId },
        'agentSession.queuedMessageSend',
        clientOperationId,
        sessionId
      ),
      messageId
    })
  }

  function deleteQueued(messageId: string, clientOperationId = hostTestOperationId()) {
    return host.queuedMessageDelete(QUEUED_RIG_CALLER, {
      envelope: envelope({ messageId }, 'agentSession.queuedMessageDelete', clientOperationId),
      messageId
    })
  }

  async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
    return (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === id
    )
  }

  /** The latest submission that hands off this draft, found by its link. */
  async function handoff(draftId: string): Promise<AgentJournalSubmission | undefined> {
    return (await host.journalSnapshot(SESSION)).submissions.findLast(
      (entry) => entry.queuedMessageId === draftId
    )
  }

  /** The submission id a draft went out under: never the draft's own id. */
  async function handoffId(draftId: string): Promise<string> {
    const sent = await handoff(draftId)
    if (!sent) {
      throw new Error(`draft ${draftId} has not been handed off`)
    }
    return sent.clientMessageId
  }

  async function drafts(
    sessionId = SESSION
  ): Promise<{ messageId: string; state: string; paused?: true }[]> {
    const page = await host.history({ sessionId, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    return (page.page.queuedMessages ?? []).map(({ messageId, state, paused }) => ({
      messageId,
      state,
      ...(paused ? { paused } : {})
    }))
  }

  /** A first send that keeps the session working until the test settles it. */
  async function workingSend(): Promise<string> {
    const { id, result } = send('work on this')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    return id
  }

  async function settleAccepted(id: string, itemId: string): Promise<void> {
    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: id,
      providerIdentity: {
        provider: 'codex',
        threadId: THREAD,
        turnId: `turn-${itemId}`,
        ordinal: 0
      }
    })
  }

  /** A provider refusal, written as the host writes one: the sentence and the typed fact. */
  async function settleRejected(id: string, providerText: string): Promise<void> {
    const detail = { text: providerText, audience: 'person' as const }
    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: id,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerRejected', { detail }), {
        surface: 'rejection'
      })
    })
  }

  /** What the provider's translator writes when a /compact's turn ends, as a success. */
  function finishCompact(): void {
    const { command } = compact.mock.calls.at(-1)![0]
    events!.appendLifecycleBatch!(
      `turn-completed:${command.clientMessageId}`,
      [
        {
          kind: 'item',
          identity: command.identity,
          body: { ...command.running, state: 'completed', outcome: 'success', completedAt: NOW },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ],
      { lifecycle: true }
    )
  }

  /** A host-process restart, as the queue sees it: the conversation closes, and
   *  opens afresh under a new instance id while its rows survive. */
  async function restartHostProcess(): Promise<void> {
    await host.close(SESSION)
    rotateStructuredAgentSessionHostInstanceForTests()
  }

  /** The queue's published pause: null when it sends on its own. */
  async function queuePause(sessionId = SESSION): Promise<AgentSessionQueuePause | null> {
    const page = await host.history({ sessionId, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    return page.page.queuePause ?? null
  }

  function resume(clientOperationId = hostTestOperationId()) {
    return host.queuedMessagesResume(QUEUED_RIG_CALLER, {
      envelope: envelope({}, 'agentSession.queuedMessagesResume', clientOperationId)
    })
  }

  async function dispose(): Promise<void> {
    await host.flushAllStreamedEvents()
    await rm(root, { recursive: true, force: true })
  }

  return {
    root,
    store,
    host,
    dispatch,
    awaitStarted,
    compact,
    finishCompact,
    envelope,
    send,
    stop,
    sendNow,
    deleteQueued,
    submission,
    handoff,
    handoffId,
    drafts,
    workingSend,
    settleAccepted,
    settleRejected,
    restartHostProcess,
    queuePause,
    resume,
    dispose
  }
}
