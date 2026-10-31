import { expect, vi } from 'vitest'
import { setup, finishReadExperimentTurn } from './automation-chat-notification-test-fixture'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { RuntimeMobileNotificationController } from '../runtime/runtime-mobile-notification-controller'
import { stubRuntime } from '../runtime/rpc/terminal-multiplex-test-harness'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS } from '../runtime/rpc/methods/structured-agent-session-turn-completion-stream'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  HOST_TEST_SESSION as DEFAULT_SESSION,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { automationRunOperationId, AUTOMATION_AGENT_CALLER } from './automation-run-operation'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import { observeAutomationChatRun } from './runtime-chat-run-observer'
import { createAutomationRunWriter } from './automation-run-writer'
import { publishAutomationOutcome } from './automation-outcome-notification'
import type { AgentJournalCursor } from '../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import { providerItemIdOf } from '../native-chat/agent-session-wire/structured-rewind-cut'
import type { JournalPublication } from '../native-chat/agent-session-wire/structured-agent-session-conversations'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import type { AutomationRun } from '../../shared/automations-types'
import type { AutomationAttentionDelivery } from '../runtime/automation-attention-correlations'

export async function readContextFixture(
  sessionId = DEFAULT_SESSION,
  sharedController?: RuntimeMobileNotificationController
) {
  const SESSION = sessionId
  const rig = await setup(undefined, sessionId)
  setStructuredAgentSessionHost(rig.host)
  const state = await fixture()
  const { store } = state
  const definition = store.updateAutomation(store.listAutomations()[0].id, { agentId: 'codex' })
  const controller = sharedController ?? new RuntimeMobileNotificationController()
  const owner = controller.createAutomationAttentionOwner()
  rig.host.automationChatInterests.connectAttention(owner.get)
  const runtime = stubRuntime({
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => rig.store,
    retireStructuredAttention: controller.retireStructuredAttention.bind(controller),
    dispatchMobileNotification: controller.dispatch.bind(controller),
    notifyAutomationsChanged: vi.fn()
  })
  const rpc = new RpcDispatcher({
    runtime,
    methods: STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS
  })
  const changes: AutomationsChangedPayload[] = []
  let onPublish: ((delivery?: AutomationAttentionDelivery) => void) | undefined
  const writer = createAutomationRunWriter(
    store,
    (payload, delivery) => {
      changes.push(payload)
      onPublish?.(delivery)
      publishAutomationOutcome(runtime, store, payload, delivery)
    },
    owner
  )
  const abort = new AbortController()
  const edges: AgentSessionTurnCompletionEvent[] = []
  const release = rig.host.subscribeTurnCompletions({
    id: 'read-context',
    includePrompts: true,
    emit: (event) => edges.push(event)
  })
  let occurrence = 1_800_000_000_000
  async function start(existing?: AutomationRun, signal = abort.signal) {
    const pending = existing ?? store.createAutomationRun(definition, occurrence++, 'manual')
    const run = store.updateAutomationRun({
      runId: pending.id,
      status: 'dispatched',
      sessionKind: 'chat',
      chatSessionId: SESSION,
      workspaceId: 'workspace-1'
    })
    const attention = owner.admit(run.id)
    const message = automationRunOperationId(run, 'reuse-send')
    rig.host.registerAutomationChatRun(run.id, SESSION, message)
    const fields = { body: hostTestMessage('check') }
    expect(
      await rig.host.send(
        { callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER) },
        {
          ...fields,
          envelope: rig.envelope(fields, 'agentSession.send', message)
        }
      )
    ).toMatchObject({ ok: true })
    const observing = observeAutomationChatRun(runtime, run, signal, attention)
    void observing.catch(() => {})
    await Promise.resolve()
    return { run, message, attention, observing }
  }
  async function read(cursor: AgentJournalCursor, sessionId = SESSION) {
    expect(
      await rpc.dispatch({
        id: 'read',
        authToken: 'fixture',
        method: 'agentSession.acknowledgeAttention',
        params: { sessionId, observedCursor: cursor }
      })
    ).toMatchObject({ ok: true, result: { acknowledged: true } })
  }
  async function finish(
    running: Awaited<ReturnType<typeof start>>,
    beforeTerminal?: () => Promise<void>
  ) {
    await finishReadExperimentTurn(
      rig,
      SESSION,
      running.message,
      running.run.id,
      'success',
      undefined,
      beforeTerminal
    )
    return await running.observing
  }
  function publications() {
    const hints: JournalPublication[] = []
    const release = rig.host.observeConversationPublications(SESSION, {
      next: (hint) => hints.push(hint),
      error: (error) => {
        throw error
      }
    })
    return { hints, release }
  }
  async function replaceEpochRetainingMessages() {
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    const kept = journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
      .map((item) => {
        const identity = parseAgentJournalItemKey(providerItemIdOf(journal, item.itemId))
        if (!identity) {
          throw new Error('Expected canonical provider message identity')
        }
        const provenance = journal.itemProvenance(item.itemId)
        return {
          identity,
          body: item.body,
          observedAt: item.observedAt,
          turnScope: item.turnScope,
          ...agentJournalLinkageFields(item),
          ...provenance,
          ownerFence: provenance.ownerFence ?? fence
        }
      })
    expect(kept.length).toBeGreaterThan(0)
    return await journal.replaceEpochItems('handle_forked', fence, kept)
  }
  async function commit(run: AutomationRun, observation: Awaited<ReturnType<typeof finish>>) {
    return writer.updateRun({ runId: run.id, ...observation })
  }
  return {
    ...state,
    rig,
    controller,
    owner,
    runtime,
    writer,
    changes,
    edges,
    definition,
    start,
    read,
    finish,
    commit,
    replaceEpochRetainingMessages,
    publications,
    abort: () => abort.abort(),
    publishing: (callback: (delivery?: AutomationAttentionDelivery) => void) => {
      onPublish = callback
    },
    dispose: () => {
      abort.abort()
      writer.dispose()
      release()
      setStructuredAgentSessionHost(null)
    }
  }
}
