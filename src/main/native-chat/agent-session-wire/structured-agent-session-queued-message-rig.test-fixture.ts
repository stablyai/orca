// One real-host rig for the mid-turn queue suites: store, journal, the scripted provider
// (`...-rig-provider.test-fixture.ts`), and the send/stop/draft helpers every suite shares.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuePause } from '../../../shared/agent-session-wire'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { agentSessionMessagePayload } from '../../../shared/structured-agent-session-send-mutation'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
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
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  createQueuedRigProvider,
  type QueuedRigProviderOptions
} from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

export const QUEUED_RIG_CALLER = { callerKey: 'client-1' }
type RigSendOptions = { internal?: true; from?: AgentMessageSource }

export function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

export type QueuedMessageTestRig = Awaited<ReturnType<typeof createQueuedMessageTestRig>>

export async function createQueuedMessageTestRig(
  options: QueuedRigProviderOptions & {
    /** Lets a test sweep idle chats on its own `tick`. */
    idleSweep?: { idleMs: number; intervalMs: number }
    /** Teardown records its restart offers, which `restartOffers` lists. */
    recoveryCapsule?: true
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-queued-messages-'))
  resetHostTestOperationIds()
  const store = await openTestAgentSessionRecordStore(root)
  const provider = createQueuedRigProvider(store, options)
  const { dispatch, compact, cancelTurn, closeSession } = provider
  const makeHost = () =>
    new StructuredAgentSessionHost({
      agents: claudeAndCodexDeclared(),
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: provider.adapter,
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-1',
      now: () => NOW,
      ...(options.idleSweep ? { idleSweep: options.idleSweep } : {}),
      ...(options.recoveryCapsule ? { recoveryCapsule: new AgentSessionRecoveryCapsule(root) } : {})
    })
  let host = makeHost()
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
      payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
    }
  }

  /** A client's send, as the `agentSession.send` RPC hands it to the host;
   *  `internal` is a host-side sender (orchestration mail, a restart continuation), and `from`
   *  the agent it is from. */
  function send(text: string, delivery?: 'queue-if-active', options?: RigSendOptions) {
    const body = { ...hostTestMessage(text), ...(options?.from ? { from: options.from } : {}) }
    const clientOperationId = hostTestOperationId()
    // Fingerprinted as the host digests a send: the message without its sender.
    const fields = { body: agentSessionMessagePayload(body), ...(delivery ? { delivery } : {}) }
    const result = host.send(QUEUED_RIG_CALLER, {
      envelope: envelope(fields, 'agentSession.send', clientOperationId),
      ...fields,
      body,
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

  /** A host-process restart: the app quits (its own teardown runs) and a new host opens the same
   *  state. A quit writes no close's Stop event, so a person's Stop pause survives it. */
  async function restartHostProcess(): Promise<void> {
    await quitRestartHostProcess()
  }

  /** A host process that dies with no close: a new host opens the same state directory. */
  function crashRestartHostProcess(): void {
    rotateStructuredAgentSessionHostInstanceForTests()
    host = makeHost()
  }

  /** The app quits — the host's own teardown runs — and a new host opens the same state. */
  async function quitRestartHostProcess(): Promise<void> {
    await host.flushAllStreamedEvents()
    crashRestartHostProcess()
  }

  /** The queue's published pause: null when it sends on its own. */
  async function queuePause(sessionId = SESSION): Promise<AgentSessionQueuePause | null> {
    const page = await host.history({ sessionId, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    return page.page.queuePause ?? null
  }

  /** The restart offers this host lists for the chats an earlier one stopped. */
  async function restartOffers() {
    return (await host.restartResume.list()).map(({ sessionId, work }) => ({ sessionId, work }))
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
    get host() {
      return host
    },
    dispatch,
    cancelTurn,
    closeSession,
    compact,
    starts: provider.starts,
    holdNextStart: provider.holdNextStart,
    finishCompact: provider.finishCompact,
    providerEvents: provider.providerEvents,
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
    crashRestartHostProcess,
    quitRestartHostProcess,
    queuePause,
    restartOffers,
    resume,
    dispose
  }
}
