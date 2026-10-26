import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuePause } from '../../../shared/agent-session-wire'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { agentSessionMessagePayload } from '../../../shared/structured-agent-session-send-mutation'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import {
  StructuredAgentSessionHost,
  type StructuredAgentSessionHostDeps
} from './structured-agent-session-host'
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
type RigSendOptions = {
  internal?: true
  from?: AgentMessageSource
  carried?: Readonly<Record<string, string>>
}

export function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

export type QueuedMessageTestRig = Awaited<ReturnType<typeof createQueuedMessageTestRig>>

export async function createQueuedMessageTestRig(
  options: QueuedRigProviderOptions & {
    idleSweep?: { idleMs: number; intervalMs: number }
    now?: () => number
    /** Teardown records its restart offers, which `restartOffers` lists. */
    recoveryCapsule?: true
    location?: AgentSessionExecutionLocation
    /** Defaults to indeterminate. */
    probeOwner?: StructuredAgentSessionHostDeps['probeOwner']
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-queued-messages-'))
  resetHostTestOperationIds()
  const store = await openTestAgentSessionRecordStore(root)
  const provider = createQueuedRigProvider(store, options, () => host)
  const { dispatch, compact, cancelTurn, closeSession, setOption } = provider
  const makeHost = () =>
    new StructuredAgentSessionHost({
      agents: claudeAndCodexDeclared(),
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: provider.adapter,
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-1',
      now: options.now ?? (() => NOW),
      ...(options.probeOwner ? { probeOwner: options.probeOwner } : {}),
      ...(options.idleSweep ? { idleSweep: options.idleSweep } : {}),
      ...(options.recoveryCapsule ? { recoveryCapsule: new AgentSessionRecoveryCapsule(root) } : {})
    })
  let host = makeHost()
  const firstAttach = hostTestAttachParams(
    null,
    options.location ? { location: options.location } : {}
  )
  expect(await host.attach(QUEUED_RIG_CALLER, firstAttach)).toMatchObject({ ok: true })

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

  /** Match client RPC sends; internal marks host-origin mail/continuations, from identifies the agent. */
  function send(text: string, delivery?: 'queue-if-active', options?: RigSendOptions) {
    const body = { ...hostTestMessage(text), ...(options?.from ? { from: options.from } : {}) }
    const clientOperationId = hostTestOperationId()
    // Sender identity is excluded from the payload fingerprint.
    const fields = {
      body: agentSessionMessagePayload(body),
      ...(delivery ? { delivery } : {}),
      ...(options?.carried ? { options: options.carried } : {})
    }
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

  async function handoff(draftId: string): Promise<AgentJournalSubmission | undefined> {
    return (await host.journalSnapshot(SESSION)).submissions.findLast(
      (entry) => entry.queuedMessageId === draftId
    )
  }

  /** Handoff submission IDs differ from their draft IDs. */
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

  /** Wait for startup proof before the first send can hold work. */
  async function workingSend(carried?: RigSendOptions['carried']): Promise<string> {
    const { id, result } = send('work on this', undefined, carried ? { carried } : undefined)
    await result
    await eventually(async () => {
      if (host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase === 'starting') {
        await proveProviderOpen()
      }
      expect((await submission(id))?.handedOverAt).toBeDefined()
    })
    return id
  }

  async function settleAccepted(id: string, itemId: string): Promise<void> {
    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: id,
      providerIdentity: {
        provider: 'codex',
        threadId: activeProviderContext(store.getRecord(SESSION)!).head?.handle.nativeId ?? THREAD,
        turnId: `turn-${itemId}`,
        ordinal: 0
      }
    })
  }

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

  /** Graceful restart preserves personal Stop pauses because quit writes no close Stop event. */
  async function restartHostProcess(): Promise<void> {
    await quitRestartHostProcess()
  }

  /** Replace the host without graceful close, reusing persisted state. */
  function crashRestartHostProcess(): void {
    host = makeHost()
  }

  async function quitRestartHostProcess(): Promise<void> {
    await host.flushAllStreamedEvents()
    crashRestartHostProcess()
  }

  async function queuePause(sessionId = SESSION): Promise<AgentSessionQueuePause | null> {
    const page = await host.history({ sessionId, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    return page.page.queuePause ?? null
  }

  async function restartOffers() {
    return (await host.restartResume.list()).map(({ sessionId, work }) => ({ sessionId, work }))
  }

  function resume(clientOperationId = hostTestOperationId()) {
    return host.queuedMessagesResume(QUEUED_RIG_CALLER, {
      envelope: envelope({}, 'agentSession.queuedMessagesResume', clientOperationId)
    })
  }

  async function proveStart(): Promise<void> {
    await eventually(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
    )
    await proveProviderOpen()
  }

  async function proveProviderOpen(): Promise<void> {
    provider.proveOpen()
    await Promise.resolve()
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
    setOption,
    cancelTurn,
    closeSession,
    compact,
    starts: provider.starts,
    holdNextStart: provider.holdNextStart,
    failNextStart: provider.failNextStart,
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
    proveStart,
    dispose
  }
}
