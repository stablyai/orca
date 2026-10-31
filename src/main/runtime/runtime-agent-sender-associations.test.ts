import { afterEach, expect, it, vi } from 'vitest'
import { createRuntimeAgentProjections } from './construction/runtime-agent-projections'
import { fingerprintOrchestrationPeer } from './orchestration/environment-transport'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { MIRROR_LEAVES_STEP_1 } from './runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { AgentSessionRecordReader } from './orchestration/structured-session-lineage'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey
} from './structured-worker-identity'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'

const dbs: OrchestrationDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})
const leaf = (id: string) =>
  `${(Number(id.replace('tab-', '')) + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
const pane = (id: string) => `${id}:${leaf(id)}`
function harness(n = 1, records: AgentSessionRecordReader | null = null) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'identity',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  dbs.push(db)
  const leaves: RuntimeLeafRecord[] = Array.from({ length: n }, (_, i) => ({
    ...MIRROR_LEAVES_STEP_1[0],
    tabId: `tab-${i}`,
    worktreeId: 'workspace',
    ptyId: `pty-${i}`
  }))
  let openedDb: OrchestrationDb | null = null
  const openHistory = vi.fn(() => (openedDb = db))
  const { senders: projection } = createRuntimeAgentProjections(
    {
      getExistingOrchestrationDb: openHistory,
      getE2EEPublicKey: () => 'execution-key',
      resolveOrchestrationWorkerServer: () => ({
        environmentId: 'remote',
        name: 'Remote',
        peerFingerprint: 'execution-peer',
        homePeerFingerprint: 'paired-home'
      })
    },
    {
      getDb: () => openedDb,
      getLeaves: () => leaves,
      getPtys: () => [],
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      issueLeafHandle: (leaf) => `term_now_${leaf.tabId}`,
      issuePtyHandle: () => '',
      makePaneKey: (leaf) => pane(leaf.tabId),
      getWorktreeId: () => null,
      getHandleForPaneKey: () => null,
      getPaneKey: () => null,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getSessionRecords: () => records
    }
  )
  const dispatch = (id: number, handle = `term_old_${id}`, key = pane(`tab-${id}`)) =>
    createRootDispatch(db, db.createTask({ runId: run.id, spec: `worker ${id}` }).id, handle, key)
  return { db, leaves, projection, dispatch, openHistory }
}
it('recovers old terminal handles and Started-worker dispatches after restart, including ordinary coordinators', () => {
  const { db, projection, dispatch, openHistory } = harness()
  const worker = dispatch(0)
  db.insertMessage({
    from: 'term_old_coordinator',
    to: 'recipient',
    subject: 'task',
    senderPaneKey: pane('tab-0')
  })
  const rows = projection.build().associations
  for (const address of [
    `dispatch:${worker.id}`,
    'term_old_0',
    'term_old_coordinator',
    'term_now_tab-0'
  ]) {
    expect(rows.find((row) => row.address === address)).toMatchObject({
      paneKey: pane('tab-0'),
      worktreeId: 'workspace'
    })
  }
  expect(projection.build()).toBe(projection.build())
  expect(openHistory).toHaveBeenCalledTimes(1)
})
it('follows proven reopened-worker lineage instead of the old pane or a matching name', () => {
  const { db, projection, dispatch } = harness(3)
  const old = dispatch(0)
  const latest = dispatch(1)
  db.db
    .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
    .run(old.id, latest.id)
  db.insertMessage({
    from: 'term_old_0',
    to: 'recipient',
    subject: 'update',
    senderPaneKey: pane('tab-0')
  })
  dispatch(2)
  for (const address of ['term_old_0', `dispatch:${old.id}`]) {
    expect(
      projection
        .build()
        .associations.filter((r) => r.address === address)
        .every((r) => r.paneKey === pane('tab-1'))
    ).toBe(true)
  }
})
it('publishes plain chats and canonical /clear successors without credential handles or credential panes', () => {
  const root = testOrcaSessionId('11111111-1111-4111-8111-111111111111')
  const live = testOrcaSessionId('22222222-2222-4222-8222-222222222222')
  const base = (sessionId: string) =>
    agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  const original = {
    ...base(root),
    conversationCommand: {
      command: 'clear',
      state: 'completed',
      replacementSessionId: live,
      operationId: 'op',
      callerKey: 'k',
      phase: 'committed'
    }
  } as const
  const rows = [agentSessionConversationView(original), agentSessionConversationView(base(live))]
  const { projection, dispatch } = harness(0, {
    getRecord: (id) => rows.find((r) => r.sessionId === id) ?? null,
    listRecords: () => rows
  })
  const handle = mintStructuredWorkerHandle()
  const credentialPane = mintStructuredWorkerPaneKey(root)
  dispatch(0, handle, credentialPane)
  const associations = projection.build().associations
  expect(associations.find((r) => r.address === `orca_session_id:${root}`)).toMatchObject({
    sessionId: live
  })
  expect(associations.find((r) => r.address === `orca_session_id:${live}`)).toMatchObject({
    sessionId: live
  })
  expect(JSON.stringify(projection.build())).not.toContain(handle)
  expect(JSON.stringify(projection.build())).not.toContain(credentialPane)
})
it.each([100, 1000])(
  'batches provenance reads for %i panes and reuses identity on status-only updates',
  (n) => {
    const { db, projection, dispatch, leaves } = harness(n)
    const chain = Array.from({ length: n }, (_, i) => dispatch(i))
    for (let i = 1; i < n; i++) {
      db.db
        .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
        .run(chain[i - 1].id, chain[i].id)
    }
    const reads = vi.spyOn(db.db, 'prepare')
    const first = projection.build()
    expect(first.associations).toHaveLength(n * 3)
    const historyReads = () =>
      reads.mock.calls.filter(([sql]) =>
        /FROM (dispatch_contexts|worker_terminal_resources|messages|remote_dispatch_attachments|federated_dispatches)/.test(
          sql
        )
      ).length
    expect(historyReads()).toBe(5)
    expect(projection.workForTest().lineageReads).toBeLessThanOrEqual(n * 3)
    leaves[0].lastOutputAt = 100
    expect(projection.build()).toBe(first)
    expect(projection.build('workspace').associations).toHaveLength(n * 3)
    expect(historyReads()).toBe(5)
  }
)

it('publishes authenticated execution attachments separately from home-qualified routes', () => {
  const { db, projection } = harness()
  db.createRemoteDispatchAttachment({
    dispatchId: 'federated',
    taskId: 'task',
    homePeerFingerprint: 'paired-home',
    protocolVersion: 1,
    runtimeEpoch: 'epoch',
    mutationReceipt: {
      callerFingerprint: 'paired-home',
      requestId: 'attach',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'fixture'
    }
  })
  db.prepareRemoteAttachmentAuthority({
    dispatchId: 'federated',
    paneKey: pane('tab-0'),
    processIncarnation: 'process',
    worktreeId: 'workspace',
    terminalHandle: 'term_now_tab-0',
    setupState: 'skipped',
    effects: []
  })
  db.db
    .prepare(
      'INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version) VALUES (?, ?, ?, ?, ?)'
    )
    .run('federated', 'remote', 'Remote', 'execution-peer', 1)
  const publicRows = projection.build('workspace')
  expect(publicRows.peerFingerprint).toBe(fingerprintOrchestrationPeer('execution-key'))
  expect(publicRows.federation).toEqual([
    {
      dispatchId: 'federated',
      peerFingerprint: 'execution-peer',
      homePeerFingerprint: 'paired-home'
    }
  ])
  expect(publicRows.attachments).toEqual([
    {
      address: 'dispatch:federated',
      paneKey: pane('tab-0'),
      worktreeId: 'workspace',
      homePeerFingerprint: 'paired-home'
    }
  ])
  expect(publicRows.associations.some((row) => row.address === 'dispatch:federated')).toBe(false)
})
