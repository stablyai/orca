import { expect, vi } from 'vitest'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-host-contract'
import { OrchestrationDb } from './db'
import { RuntimeOrchestrationSenderNames } from '../runtime-orchestration-sender-names'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import {
  structuredSessionMailTarget,
  handleLessCoordinatorSessionId
} from './structured-session-mail-target'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'

export async function verifyHeldLocalWorkerDone(mode: string): Promise<void> {
  const liveReplacement = mode === 'live-other-kind'
  const db = new OrchestrationDb(':memory:')
  try {
    const coordinator = testOrcaSessionId('held-mail-coordinator')
    const record = agentSessionConversationView(
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: coordinator }))
    )
    const reader = {
      getRecord: (id: string) => (id === coordinator ? record : null),
      listRecords: () => [record]
    }
    const run = db.createRun({
      objective: 'held mail',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: coordinator
    })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskRunId: run.id,
      taskSpec: 'Inspect parser',
      startOptions: { agent: 'codex' }
    })
    const dispatchId = started.dispatch.id
    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: 'term_local_codex',
      paneKey: 'tab_worker:leaf',
      processIncarnation: 'p:1',
      worktreeId: 'workspace-1',
      effects: [],
      setupState: 'not_applicable'
    })
    db.markWorkerDispatchReady(dispatchId)
    const mail = db.insertMessage({
      from: 'term_local_codex',
      to: `run:${run.id}`,
      runId: run.id,
      subject: 'done',
      type: 'worker_done',
      senderPaneKey: 'tab_worker:leaf',
      payload: JSON.stringify({ dispatchId, taskId: started.task.id, outcome: 'succeeded' })
    })
    expect(reconcileLifecycleMessage(db, mail).action).toBe('completed')
    let live = true
    let awaitingHuman = true
    const names = new RuntimeOrchestrationSenderNames({
      getDb: () => db,
      getHandleRecord: () =>
        live ? { worktreeId: 'workspace-1', tabId: 'tab_worker', ptyId: 'pty_worker' } : undefined,
      getPtyAgents: () =>
        live ? { launchAgent: liveReplacement ? 'claude' : 'codex' } : undefined,
      getTerminalPaneKey: () => (live ? 'tab_worker:leaf' : null),
      getWorkspaceSession: () => null,
      getGeneratedTitlesEnabled: () => false,
      getAgentStatusSnapshotForPane: () => [],
      getTrackedTitle: () => null
    })
    const acceptedTurns: string[] = []
    const accepted = Promise.withResolvers<void>()
    const send = vi.fn<StructuredMailboxPointerHost['send']>(async (input) => {
      expect(input.stillOwed()).toBe(true)
      if (awaitingHuman) {
        return { kind: 'held' }
      }
      expect(db.getMessageById(mail.id)?.delivered_at).toBeNull()
      await accepted.promise
      acceptedTurns.push(input.operationId)
      return { kind: 'sent', state: 'accepted' }
    })
    const mark = vi.spyOn(db, 'markAsDelivered')
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (mailbox) => {
        const bound = mailbox === `run:${run.id}` ? db.getRun(run.id) : undefined
        const id = bound ? handleLessCoordinatorSessionId(bound) : null
        return id ? structuredSessionMailTarget(id, db, reader) : null
      },
      getCliCommand: () => 'orca',
      senderSnapshot: (party, reported) => names.snapshotOf(party, reported),
      host: {
        readSessionFacts: async () => ({ submissions: [] }),
        hasActionablePromptNow: () => awaitingHuman,
        isWorkingNow: () => false,
        currentFence: () => 1,
        currentContextClearOperationId: () => undefined,
        send
      }
    })
    delivery.deliverForHandle(`run:${run.id}`)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(acceptedTurns).toEqual([])
    expect(mark).not.toHaveBeenCalled()
    expect(db.getMessageById(mail.id)?.delivered_at).toBeNull()
    live = liveReplacement
    if (mode === 'metadata-read-fails') {
      vi.spyOn(db, 'getWorkerDispatch').mockImplementation(() => {
        throw new Error('metadata read unavailable')
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    }
    expect(db.getDispatchContextById(dispatchId)?.assignee_handle).toBe('term_local_codex')
    awaitingHuman = false
    send.mockClear()
    delivery.onJournalActivity(coordinator)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0].body.from).toMatchObject({
      senders: [
        {
          party: { address: 'term_local_codex', terminalHandle: 'term_local_codex' },
          name: 'Inspect parser',
          ...(mode === 'metadata-read-fails' ? {} : { agent: liveReplacement ? 'claude' : 'codex' })
        }
      ],
      orchestration: { messages: [{ messageId: mail.id }] }
    })
    expect(acceptedTurns).toEqual([])
    expect(mark).not.toHaveBeenCalled()
    accepted.resolve()
    await vi.waitFor(() => expect(mark).toHaveBeenCalledWith([mail.id], `run:${run.id}`))
    expect(db.getMessageById(mail.id)?.delivered_at).toEqual(expect.any(String))
    expect(acceptedTurns).toHaveLength(1)
    if (mode === 'metadata-read-fails') {
      expect(send.mock.calls[0][0].body.from?.senders[0].agent).toBeUndefined()
      expect(console.warn).toHaveBeenCalledWith(
        '[orchestration] worker launch observation failed',
        expect.any(Error)
      )
    }
  } finally {
    vi.restoreAllMocks()
    db.close()
  }
}
