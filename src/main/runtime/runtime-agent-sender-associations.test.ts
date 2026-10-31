import { afterEach, expect, it, vi } from 'vitest'
import { createRuntimeAgentProjections } from './construction/runtime-agent-projections'
import {
  fingerprintOrchestrationPeer,
  pairedOrchestrationPeers
} from './orchestration/environment-transport'
import { devicePrincipalOf } from './device-principal'
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
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { agentConversationIdentity } from './runtime-agent-sender-conversations'
import { structuredMailSource } from './orchestration/structured-mail-source'
import { dispatchTaskSource } from './orchestration/dispatch-task-source'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'

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
const conversation = agentConversationIdentity
const claudeProcess = { pid: 4242, platform: 'darwin' as const, startTime: 'boot-1' }
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only these fields.
  const ptys = leaves.map(
    (l) =>
      ({
        ptyId: l.ptyId,
        incarnationId: 'inc-1',
        worktreeId: 'workspace'
      }) as RuntimePtyWorktreeRecord
  )
  let openedDb: OrchestrationDb | null = null
  const openHistory = vi.fn(() => (openedDb = db))
  let generation = 0
  const start = () => {
    generation++
    const { senders, setPeerKey } = createRuntimeAgentProjections(
      {
        getExistingOrchestrationDb: openHistory,
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
        getPtys: () => ptys,
        paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
        // Handles are reissued on every start; identities must not depend on them.
        issueLeafHandle: (leaf) => `term_${generation}_${leaf.tabId}`,
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
    setPeerKey(() => 'execution-key')
    db.agentSenderIdentityOf = (address, paneKey) => senders.identityAt(db, address, paneKey)
    return senders
  }
  let projection = start()
  const dispatch = (id: number, handle = `term_old_${id}`, key = pane(`tab-${id}`)) =>
    createRootDispatch(db, db.createTask({ runId: run.id, spec: `worker ${id}` }).id, handle, key)
  const hook = (
    tab: number,
    agent: string,
    session: string,
    options: { dispatchId?: string; process?: typeof claudeProcess } = {}
  ) =>
    projection.observeHook(db, {
      paneKey: pane(`tab-${tab}`),
      agent,
      session,
      process: options.process,
      dispatchId: options.dispatchId ?? null
    })
  const located = (identity: string) =>
    projection.build().associations.find((row) => row.identity === identity)?.paneKey
  return {
    db,
    run,
    leaves,
    get projection() {
      return projection
    },
    restart: () => (projection = start()),
    dispatch,
    hook,
    located,
    openHistory
  }
}

it('locates a worker by its Dispatch only while the conversation it was attached with runs there', () => {
  const h = harness(2)
  const worker = h.dispatch(0)
  // Before its first hook, the Dispatch's own launch is the proof.
  expect(h.located(`dispatch:${worker.id}`)).toBe(pane('tab-0'))
  h.hook(0, 'claude', 'worker-session', { dispatchId: worker.id })
  expect(h.located(`dispatch:${worker.id}`)).toBe(pane('tab-0'))
  expect(h.located(conversation('claude', 'worker-session'))).toBe(pane('tab-0'))
  // A different agent in the same terminal is not the worker.
  h.hook(0, 'codex', 'someone-else', { dispatchId: worker.id })
  expect(h.located(`dispatch:${worker.id}`)).toBeUndefined()
  expect(h.located(conversation('claude', 'worker-session'))).toBeUndefined()
  // Nor is an unrelated new conversation of the same agent.
  h.hook(0, 'claude', 'fresh-claude', { dispatchId: worker.id })
  expect(h.located(`dispatch:${worker.id}`)).toBeUndefined()
  expect(h.located(conversation('claude', 'fresh-claude'))).toBe(pane('tab-0'))
  expect(h.projection.build().associations.some((r) => r.identity.startsWith('term_'))).toBe(false)
})

it('keeps a sender across /clear only when the same agent process reports the new session', () => {
  const h = harness(1)
  const worker = h.dispatch(0)
  h.hook(0, 'claude', 'before-clear', { dispatchId: worker.id, process: claudeProcess })
  h.hook(0, 'claude', 'after-clear', { dispatchId: worker.id, process: claudeProcess })
  expect(h.located(conversation('claude', 'before-clear'))).toBe(pane('tab-0'))
  expect(h.located(`dispatch:${worker.id}`)).toBe(pane('tab-0'))
  h.hook(0, 'claude', 'new-process', { process: { ...claudeProcess, pid: 4343 } })
  expect(h.located(conversation('claude', 'before-clear'))).toBeUndefined()
  expect(h.located(`dispatch:${worker.id}`)).toBeUndefined()
})

it('saves who sent mail when it is accepted, so delivery after a replacement keeps the real sender', () => {
  const h = harness(2)
  h.hook(1, 'claude', 'coordinator')
  const before = h.db.insertMessage({
    from: 'term_coord',
    to: 'worker',
    subject: 'a',
    senderPaneKey: pane('tab-1')
  })
  h.hook(1, 'codex', 'replacement')
  const after = h.db.insertMessage({
    from: 'term_coord',
    to: 'worker',
    subject: 'b',
    senderPaneKey: pane('tab-1')
  })
  const source = structuredMailSource({
    db: h.db,
    mailboxHandle: 'worker',
    dispatchId: null,
    batch: [before, after],
    senderSnapshot: () => ({ name: 'Coordinator', agent: 'claude' })
  })
  // One handle, two agents: two senders, each with what ran when Orca accepted its mail.
  expect(source.senders.map((s) => [s.party.address, s.identity])).toEqual([
    ['term_coord', conversation('claude', 'coordinator')],
    ['term_coord', conversation('codex', 'replacement')]
  ])
  expect(h.located(conversation('claude', 'coordinator'))).toBeUndefined()
  expect(h.located(conversation('codex', 'replacement'))).toBe(pane('tab-1'))
})

it('names a terminal coordinator on its Task card from dispatch creation, even after a restart', () => {
  const h = harness(2)
  h.hook(1, 'claude', 'coordinator')
  const task = h.db.createTask({ runId: h.run.id, spec: 'task' })
  const created = h.db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_worker',
    assigneePaneKey: pane('tab-0'),
    creator: { kind: 'terminal', handle: 'term_coord', paneKey: pane('tab-1') },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  const card = dispatchTaskSource({
    db: h.db,
    dispatch: created,
    from: 'term_coord',
    senderSnapshot: () => ({ name: 'Coordinator', agent: 'claude' })
  })
  expect(card.senders[0]?.identity).toBe(conversation('claude', 'coordinator'))
  h.restart()
  h.hook(1, 'claude', 'coordinator')
  expect(h.located(conversation('claude', 'coordinator'))).toBe(pane('tab-1'))
})

it('follows an explicit follow-up into the pane that reopened the worker, not the old pane', () => {
  const h = harness(3)
  const old = h.dispatch(0)
  const latest = h.dispatch(1)
  h.db.db
    .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
    .run(old.id, latest.id)
  h.hook(1, 'claude', 'reopened', { dispatchId: latest.id })
  expect(h.located(`dispatch:${old.id}`)).toBe(pane('tab-1'))
  // After a restart the same Dispatch still resolves; no reissued handle is consulted.
  h.restart()
  h.hook(1, 'claude', 'reopened', { dispatchId: latest.id })
  expect(h.located(`dispatch:${old.id}`)).toBe(pane('tab-1'))
})

it('rejects a worker resource whose pane now runs another process', () => {
  const h = harness(1)
  const worker = h.dispatch(0)
  h.db.db
    .prepare(
      `INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, pane_key, terminal_handle, process_incarnation, prior_owner_dispatch_ids)
       VALUES ('resource', ?, ?, ?, 'term_old_0', 'pty-0:replaced', 'not json')`
    )
    .run(worker.id, worker.id, pane('tab-0'))
  expect(h.located(`dispatch:${worker.id}`)).toBeUndefined()
  h.db.db.prepare("UPDATE worker_terminal_resources SET process_incarnation = 'pty-0:inc-1'").run()
  // A malformed former-owner list loses only that row's former owners.
  expect(h.located(`dispatch:${worker.id}`)).toBe(pane('tab-0'))
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
  const h = harness(0, {
    getRecord: (id) => rows.find((r) => r.sessionId === id) ?? null,
    listRecords: () => rows
  })
  const handle = mintStructuredWorkerHandle()
  const credentialPane = mintStructuredWorkerPaneKey(root)
  h.dispatch(0, handle, credentialPane)
  const associations = h.projection.build().associations
  expect(associations.find((r) => r.identity === `orca_session_id:${root}`)).toMatchObject({
    sessionId: live
  })
  expect(associations.find((r) => r.identity === `orca_session_id:${live}`)).toMatchObject({
    sessionId: live
  })
  expect(JSON.stringify(h.projection.build())).not.toContain(handle)
  expect(JSON.stringify(h.projection.build())).not.toContain(credentialPane)
})

it.each([100, 1000])(
  'does no identity work for heartbeats, read marks, mail or status at %i dispatches',
  (n) => {
    const h = harness(n)
    const chain = Array.from({ length: n }, (_, i) => h.dispatch(i))
    for (let i = 1; i < n; i++) {
      h.db.db
        .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
        .run(chain[i - 1].id, chain[i].id)
    }
    const first = h.projection.build()
    const other = h.projection.buildForFrame('other')
    expect(first.associations.some((r) => r.identity === `dispatch:${chain[0].id}`)).toBe(true)
    const settled = h.projection.workForTest()
    const sent = h.db.insertMessage({
      from: 'term_old_0',
      to: 'recipient',
      subject: 'beat',
      type: 'heartbeat'
    })
    h.db.recordHeartbeat(chain[n - 1].id, new Date().toISOString())
    h.db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(sent.id)
    h.db.insertMessage({
      from: 'term_old_1',
      to: 'recipient',
      subject: 'update',
      senderPaneKey: pane('tab-1')
    })
    h.leaves[0].lastOutputAt = 100
    expect(h.projection.build()).toBe(first)
    expect(h.projection.build('other')).toBe(other)
    expect(h.projection.workForTest()).toEqual(settled)
    expect(h.projection.changedScopes(['other', 'workspace'])).toEqual([])
  }
)

it('reports only worktrees whose scope changed since their last frame', () => {
  const h = harness(1)
  const workspace = h.projection.buildForFrame('workspace')
  const other = h.projection.buildForFrame('other')
  h.hook(0, 'claude', 'first')
  expect(h.projection.changedScopes(['workspace', 'other', 'never-framed'])).toEqual(['workspace'])
  expect(h.projection.build('other')).toBe(other)
  expect(h.projection.build('workspace')).not.toBe(workspace)
})

it('keeps the last good publication when a read fails and retries on the next identity change', () => {
  const h = harness(3)
  h.dispatch(0)
  const good = h.projection.build()
  const prepare = h.db.db.prepare.bind(h.db.db)
  vi.spyOn(h.db.db, 'prepare').mockImplementation((sql: string) => {
    if (sql === 'SELECT * FROM worker_terminal_resources WHERE pane_key = ?') {
      throw new Error('disk I/O error')
    }
    return prepare(sql)
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.dispatch(1)
  expect(h.projection.build()).toBe(good)
  expect(h.projection.build()).toBe(good)
  expect(h.projection.workForTest().historyReads).toBe(2)
  vi.mocked(h.db.db.prepare).mockRestore()
  const third = h.dispatch(2)
  expect(h.located(`dispatch:${third.id}`)).toBe(pane('tab-2'))
})

it('publishes one principal per paired peer and attachments only while their worker runs there', () => {
  const h = harness()
  h.db.createRemoteDispatchAttachment({
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
  h.db.prepareRemoteAttachmentAuthority({
    dispatchId: 'federated',
    paneKey: pane('tab-0'),
    processIncarnation: 'pty-0:inc-1',
    worktreeId: 'workspace',
    terminalHandle: 'term_now_tab-0',
    setupState: 'skipped',
    effects: []
  })
  const route = h.db.db.prepare(
    'INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version) VALUES (?, ?, ?, ?, ?)'
  )
  for (const id of ['federated', 'second', 'third']) {
    route.run(id, 'remote', 'Remote', 'execution-peer', 1)
  }
  const publicRows = h.projection.build('workspace')
  expect(publicRows.peerFingerprint).toBe(fingerprintOrchestrationPeer('execution-key'))
  expect(publicRows.principals).toEqual([
    { peerFingerprint: 'execution-peer', homePeerFingerprint: 'paired-home' }
  ])
  const attached = {
    identity: 'dispatch:federated',
    paneKey: pane('tab-0'),
    worktreeId: 'workspace',
    homePeerFingerprint: 'paired-home'
  }
  expect(publicRows.attachments).toEqual([attached])
  expect(publicRows.associations.some((row) => row.identity === 'dispatch:federated')).toBe(false)
  h.hook(0, 'codex', 'federated-worker')
  expect(h.projection.build('workspace').attachments).toEqual([attached])
  h.hook(0, 'claude', 'someone-else')
  expect(h.projection.build('workspace').attachments).toEqual([])
})

it('names a federated worker by the fingerprints its home derives for the runtime and itself', () => {
  // The execution runtime records the home as the principal it authenticated the home's socket as.
  const home = devicePrincipalOf({
    deviceId: 'home-device',
    name: 'Home',
    token: 'home-device-token',
    scope: 'runtime',
    pairedAt: 1,
    lastSeenAt: 1
  })
  const h = harness()
  h.db.createRemoteDispatchAttachment({
    dispatchId: 'federated',
    taskId: 'task',
    homePeerFingerprint: home.callerFingerprint,
    protocolVersion: 2,
    runtimeEpoch: 'epoch',
    mutationReceipt: {
      callerFingerprint: home.callerFingerprint,
      requestId: 'attach',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'fixture'
    }
  })
  h.db.prepareRemoteAttachmentAuthority({
    dispatchId: 'federated',
    paneKey: pane('tab-0'),
    processIncarnation: 'pty-0:inc-1',
    worktreeId: 'workspace',
    terminalHandle: 'term_now_tab-0',
    setupState: 'skipped',
    effects: []
  })
  const execution = h.projection.build('workspace')
  // The home's principal for that runtime, derived from its pairing record as main resolves it.
  const paired = pairedOrchestrationPeers('execution-key', 'home-device-token')
  expect(execution.peerFingerprint).toBe(paired.peerFingerprint)
  expect(execution.attachments.map((row) => row.homePeerFingerprint)).toEqual([
    paired.homePeerFingerprint
  ])
})

it('sends desktop clients the sender scope and strips it from phone frames', () => {
  const frame = {
    worktree: 'workspace',
    publicationEpoch: 'host',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    agentSenderAssociations: { associations: [], principals: [], attachments: [] }
  }
  expect(projectSessionTabsForClient(frame, 'mobile', undefined)).not.toHaveProperty(
    'agentSenderAssociations'
  )
  expect(projectSessionTabsForClient(frame, 'runtime', undefined).agentSenderAssociations).toEqual(
    frame.agentSenderAssociations
  )
})
