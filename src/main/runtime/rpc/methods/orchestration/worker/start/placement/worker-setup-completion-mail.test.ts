import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'
import '../../../../../../orchestration/db/contract-constants'
import '../../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../../orchestration/db/attempt-outcome-projection'
import { monitorFederatedSetup } from '../../../../../../orchestration/legacy-remote/federation-setup'
import { createOrcaSessionId } from '../../../../../../../../shared/agent-session/identity/orca-session-address'
import { monitorWorkerSetup, type WorkerSetupReceipt } from './worker-placement-topology'

// Only a failed setup needs the coordinator; a succeeded one is read from setup_state without a wake.
describe('setup completion mail', () => {
  let db: OrchestrationDb
  afterEach(() => db.close())

  const setup = (): WorkerSetupReceipt => ({
    requested: 'run',
    effective: 'run',
    source: 'repo',
    hookFound: true,
    startupPolicy: 'start-immediately',
    state: 'running'
  })
  const effects = () => [
    { kind: 'setup' as const, action: 'run', state: 'running' },
    { kind: 'terminal' as const, role: 'setup', id: 'term_setup' }
  ]
  const runtime = (exitCode: number) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setup monitoring reads only these two methods.
    ({
      waitForSetupTerminalCompletion: async () => ({ exitCode }),
      notifyMessageArrived: () => {}
    }) as unknown as OrcaRuntimeService

  function localWorker(exitCode: number) {
    db = new OrchestrationDb(':memory:')
    const runId = db.createRun({
      objective: 'setup',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
    const task = db.createTask({ runId, spec: 'work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: createOrcaSessionId(randomUUID) },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      chatLineage: false
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_agent',
      paneKey: 'tab_agent:leaf-agent',
      processIncarnation: 'pty-live:22222222-2222-4222-8222-222222222222',
      worktreeId: 'repo::/worktrees/child',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      setupState: 'running',
      effects: [],
      terminalOwnership: 'created'
    })
    monitorWorkerSetup({
      runtime: runtime(exitCode),
      db,
      runId,
      dispatchId: dispatch.id,
      setupReceipt: setup(),
      effects: effects()
    })
    return { runId, dispatchId: dispatch.id }
  }

  function remoteWorker(exitCode: number) {
    db = new OrchestrationDb(':memory:')
    const dispatchId = 'ctx_remote_setup'
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId,
      taskId: 'task_remote_setup',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: 'worker_epoch',
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'attach_remote_setup',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_hash'
      }
    })
    monitorFederatedSetup({
      runtime: runtime(exitCode),
      db,
      dispatchId,
      worktreeId: 'repo::/worktrees/child',
      terminalHandle: 'term_agent',
      setup: setup(),
      effects: effects()
    })
    return dispatchId
  }

  const messages = (runId: string) =>
    db.db.prepare('SELECT subject, priority FROM messages WHERE run_id = ?').all(runId)

  it('records a succeeded local setup without mailing the coordinator', async () => {
    const { runId, dispatchId } = localWorker(0)
    await vi.waitFor(() => expect(db.getWorkerDispatch(dispatchId)?.setup_state).toBe('succeeded'))
    expect(messages(runId)).toEqual([])
  })

  it('mails the coordinator once, at high priority, when a local setup fails', async () => {
    const { runId, dispatchId } = localWorker(1)
    await vi.waitFor(() => expect(db.getWorkerDispatch(dispatchId)?.setup_state).toBe('failed'))
    expect(messages(runId)).toEqual([
      { subject: `Setup failed for worker ${dispatchId}`, priority: 'high' }
    ])
  })

  it('relays only a failed remote setup to the home coordinator', async () => {
    const succeeded = remoteWorker(0)
    await vi.waitFor(() =>
      expect(db.getRemoteDispatchAttachment(succeeded)?.setup_state).toBe('succeeded')
    )
    expect(db.listPendingFederationRelay(succeeded, 'to_home')).toEqual([])
    db.close()

    const failed = remoteWorker(1)
    await vi.waitFor(() =>
      expect(db.getRemoteDispatchAttachment(failed)?.setup_state).toBe('failed')
    )
    const relayed = db.listPendingFederationRelay(failed, 'to_home')
    expect(relayed.map((item) => JSON.parse(item.payload))).toMatchObject([
      { subject: `Setup failed for worker ${failed}`, priority: 'high' }
    ])
  })
})
