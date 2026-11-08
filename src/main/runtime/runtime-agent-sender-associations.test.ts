import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import 'zod'
import 'node:fs'
import 'node:os'
import 'node:path'
import '../../shared/remote-runtime/host-store/runtime-environment-store-file'
import { createRuntimeAgentProjections } from './construction/runtime-agent-projections'
import {
  fingerprintOrchestrationPeer,
  pairedOrchestrationPeers
} from './orchestration/federation/environment-transport'
import { devicePrincipalOf } from './rpc/server/pairing/device-principal'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import './orchestration/db/contract-constants'
import './orchestration/db/messages/mailbox-routing-page'
import './orchestration/db/dispatch-row-writer'
import './orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { MIRROR_LEAVES_STEP_1 } from './runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord } from './terminal/records/runtime-terminal-state-records'
import { makeTuiIdlePty } from './terminal/wait/tui-idle-wait-test-harness'
import './orchestration/addressing/session-lineage/structured-session-lineage'
import type { AgentSessionRecordReader } from './orchestration/addressing/session-lineage/structured-session-lineage'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey
} from './orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import './rpc/methods/session-tabs/session-tabs-inventory'
import { AGENT_SENDER_PANE_READS } from './runtime-agent-sender-worker-history'
import './orchestration/mailbox/structured-mail/structured-mail-source'
import './agent-session-scale.test-fixture'
import './runtime-agent-sender-publication'

const unissued = (): never => {
  throw new Error('a sender build issued a terminal handle')
}

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
const handle = (i: number) => `term_tab-${i}`
/** History, chat and lineage reads; the live-terminal walk is counted by its own pass test. */
const identityReads = (h: { projection: { workForTest(): Record<string, number> } }) => {
  const { leafVisits: _leaves, ptyVisits: _ptys, ...reads } = h.projection.workForTest()
  return reads
}
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
  const ptys = Array.from({ length: n }, (_, i) =>
    makeTuiIdlePty({
      ptyId: `pty-${i}`,
      incarnationId: 'inc-1',
      launchIncarnationId: 'inc-1',
      launchToken: `launch-${i}`,
      worktreeId: 'workspace'
    })
  )
  // A warm restart keeps each terminal's handle; tests replace one to model a fresh terminal.
  const handles = new Map(leaves.map((l, i) => [l.tabId, handle(i)]))
  const scopes = new Set(['workspace', 'other'])
  const resolveServer = vi.fn(() => ({
    environmentId: 'remote',
    name: 'Remote',
    peerFingerprint: 'execution-peer',
    homePeerFingerprint: 'paired-home'
  }))
  let openedDb: OrchestrationDb | null = null
  const openHistory = vi.fn(() => (openedDb = db))
  const start = () => {
    const { senders, setPeerKey } = createRuntimeAgentProjections(
      {
        getExistingOrchestrationDb: openHistory,
        resolveOrchestrationWorkerServer: resolveServer
      },
      {
        getDb: () => openedDb,
        getLeaves: () => leaves,
        getPtys: () => ptys,
        paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
        // Orchestration issues handles; sender rows only read the ones already issued.
        issueLeafHandle: unissued,
        issuePtyHandle: unissued,
        readLeafHandle: (l) => handles.get(l.tabId) ?? null,
        readPtyHandles: () => () => null,
        hasPublishedScope: (id) => scopes.has(id),
        makePaneKey: (l) => pane(l.tabId),
        getWorktreeId: () => null,
        getHandleForPaneKey: () => null,
        getPaneKey: () => null,
        getDispatchAuthority: () => null,
        getAgentStatusSnapshot: () => [],
        getSessionRecords: () => records
      }
    )
    setPeerKey(() => 'execution-key')
    return senders
  }
  let projection = start()
  /** A worker Dispatch in tab-i whose terminal Orca holds on that very process. */
  const worker = (i: number, incarnation: string | null = `pty-${i}:inc-1`) => {
    const dispatch = createRootDispatch(
      db,
      db.createTask({ runId: run.id, spec: `worker ${i}` }).id,
      handle(i),
      pane(`tab-${i}`)
    )
    db.db
      .prepare(
        'UPDATE dispatch_contexts SET process_incarnation = ?, launch_token_hash = ? WHERE id = ?'
      )
      .run(`pty-${i}:inc-1`, createHash('sha256').update(`launch-${i}`).digest('hex'), dispatch.id)
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, pane_key, terminal_handle, process_incarnation)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        `resource-${dispatch.id}`,
        dispatch.id,
        dispatch.id,
        pane(`tab-${i}`),
        handle(i),
        incarnation
      )
    return dispatch
  }
  const located = (identity: string) =>
    projection.build().associations.find((row) => row.identity === identity)?.paneKey
  return {
    db,
    run,
    leaves,
    ptys,
    handles,
    scopes,
    get projection() {
      return projection
    },
    restart: () => (projection = start()),
    worker,
    located,
    openHistory,
    resolveServer
  }
}

it('locates every sender by the handle or Dispatch its card saved after a warm restart, with no agent event', () => {
  const h = harness(3)
  const idleWorker = h.worker(0)
  // Dispatched to tab-1's own terminal; Orca hasn't recorded that terminal for it yet.
  const starting = createRootDispatch(
    h.db,
    h.db.createTask({ runId: h.run.id, spec: 'starting' }).id,
    handle(1),
    pane('tab-1')
  )
  for (const check of [() => undefined, () => h.restart()]) {
    check()
    // Started-worker cards name the Dispatch; Message, Task and Update cards name the handle,
    // whether the sender is a hooked agent, a hooks-off agent, a plain shell or a reply.
    expect(h.located(`dispatch:${idleWorker.id}`)).toBe(pane('tab-0'))
    expect(h.located(`dispatch:${starting.id}`)).toBeUndefined()
    expect(h.located(handle(0))).toBe(pane('tab-0'))
    expect(h.located(handle(2))).toBe(pane('tab-2'))
  }
})

it('rejects released or unproven custody while keeping an independently live original execution', () => {
  const h = harness(2)
  const worker = h.worker(0)
  const settled = createRootDispatch(
    h.db,
    h.db.createTask({ runId: h.run.id, spec: 'settled' }).id,
    handle(1),
    pane('tab-1')
  )
  h.db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(settled.id)
  expect(h.located(`dispatch:${settled.id}`)).toBeUndefined()
  // A malformed former-owner list loses only that row's former owners.
  h.db.db
    .prepare("UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = 'not json'")
    .run()
  expect(h.located(`dispatch:${worker.id}`)).toBe(pane('tab-0'))
  for (const incarnation of ['pty-0:replaced', null]) {
    h.db.db.prepare('UPDATE worker_terminal_resources SET process_incarnation = ?').run(incarnation)
    expect(h.located(`dispatch:${worker.id}`)).toBe(pane('tab-0'))
  }
  h.db.db.prepare("UPDATE worker_terminal_resources SET process_incarnation = 'pty-0:inc-1'").run()
  for (const [column, value] of [
    ['ownership_state', 'released'],
    ['retained_reason', 'identity_unproven']
  ] as const) {
    h.db.db.prepare(`UPDATE worker_terminal_resources SET ${column} = ?`).run(value)
    expect(h.located(`dispatch:${worker.id}`)).toBeUndefined()
    h.db.db
      .prepare(
        "UPDATE worker_terminal_resources SET process_incarnation = 'pty-0:inc-1', ownership_state = 'owned', retained_reason = NULL"
      )
      .run()
  }
  // The terminal itself is still the one that sent the worker's cards.
  expect(h.located(handle(0))).toBe(pane('tab-0'))
})

it('does not take a respawned or fresh terminal for the one a card was sent from', () => {
  const h = harness(2)
  const worker = h.worker(0)
  expect(h.located(handle(0))).toBe(pane('tab-0'))
  // Same pane and handle, new process: a respawn that kept the handle runs a fresh shell.
  h.ptys[0] = { ...h.ptys[0], incarnationId: 'inc-2' }
  expect(h.located(handle(0))).toBeUndefined()
  expect(h.located(`dispatch:${worker.id}`)).toBeUndefined()
  // A cold restart restores the pane under a new handle; the old one names nothing.
  h.restart()
  h.handles.set('tab-1', 'term_fresh')
  expect(h.located(handle(1))).toBeUndefined()
  expect(h.located('term_fresh')).toBe(pane('tab-1'))
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
  const structured = mintStructuredWorkerHandle()
  const credentialPane = mintStructuredWorkerPaneKey(root)
  createRootDispatch(
    h.db,
    h.db.createTask({ runId: h.run.id, spec: 's' }).id,
    structured,
    credentialPane
  )
  const associations = h.projection.build().associations
  expect(associations.find((r) => r.identity === `orca_session_id:${root}`)).toMatchObject({
    sessionId: live
  })
  expect(associations.find((r) => r.identity === `orca_session_id:${live}`)).toMatchObject({
    sessionId: live
  })
  expect(JSON.stringify(h.projection.build())).not.toContain(structured)
  expect(JSON.stringify(h.projection.build())).not.toContain(credentialPane)
})

it('keeps an existing subscriber owed its update when another client reads the newer scope', () => {
  const h = harness(1)
  const first = h.projection.buildForFrame('workspace')
  h.handles.set('tab-0', 'term_changed')
  const oneShot = h.projection.buildForFrame('workspace')
  expect(oneShot).not.toBe(first)
  expect(h.projection.changedScopes(['workspace'])).toEqual(['workspace'])
  h.projection.buildForFramePass()('workspace')
  expect(h.projection.changedScopes(['workspace'])).toEqual(['workspace'])
  h.projection.acknowledgeFrame('workspace', oneShot)
  expect(h.projection.changedScopes(['workspace'])).toEqual([])
})

it('withdraws worker aliases on a failed read and retries only on the next identity change', () => {
  const chats: ReturnType<typeof agentSessionConversationView>[] = []
  const h = harness(4, {
    getRecord: (id) => chats.find((r) => r.sessionId === id) ?? null,
    listRecords: () => chats
  })
  const priorSession = testOrcaSessionId('55555555-5555-4555-8555-555555555555')
  chats.push(
    agentSessionConversationView(
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: priorSession }))
    )
  )
  const first = h.worker(0)
  const unaffected = h.worker(1)
  h.handles.set('tab-0', 'term_reminted')
  const good = h.projection.build()
  expect(good.associations.find((r) => r.identity === `dispatch:${first.id}`)?.dispatchActor).toBe(
    true
  )
  expect(good.associations.find((r) => r.identity === handle(0))?.dispatchActor).toBe(true)
  const prepare = h.db.db.prepare.bind(h.db.db)
  vi.spyOn(h.db.db, 'prepare').mockImplementation((sql: string) => {
    if (sql === AGENT_SENDER_PANE_READS.resources) {
      throw new Error('disk I/O error')
    }
    return prepare(sql)
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.worker(2)
  h.ptys[0].launchToken = null
  h.ptys[0].launchIncarnationId = null
  const safe = h.projection.build()
  expect(safe.associations).toEqual(good.associations.filter((row) => row.dispatchActor !== true))
  expect(safe.associations.some((r) => r.identity === handle(0))).toBe(false)
  expect(safe.associations.some((r) => r.identity === `dispatch:${unaffected.id}`)).toBe(false)
  expect(h.projection.build()).toBe(safe)
  vi.mocked(h.db.db.prepare).mockRestore()
  // Restoring reads alone cannot reinstate expired proof at the same failed key.
  expect(h.projection.build()).toBe(safe)
  vi.spyOn(h.db.db, 'prepare').mockImplementation((sql: string) => {
    if (sql === AGENT_SENDER_PANE_READS.resources) {
      throw new Error('disk I/O error')
    }
    return prepare(sql)
  })
  expect(identityReads(h).historyReads).toBe(2)
  // A chat opens in the same refresh as another failing read: the chat is published beside the
  // last good terminal rows.
  const chat = testOrcaSessionId('33333333-3333-4333-8333-333333333333')
  chats.push(
    agentSessionConversationView(
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: chat }))
    )
  )
  // tab-1 now runs under a fresh handle, so its terminal rows are read again, and fail.
  h.handles.set('tab-1', 'term_fresh')
  const warned = warn.mock.calls.length
  const withChat = h.projection.build().associations
  expect(withChat.filter((r) => !r.sessionId)).toEqual(
    safe.associations.filter((r) => !r.sessionId)
  )
  expect(withChat.map((r) => r.identity)).toContain(`orca_session_id:${chat}`)
  // The failure still reaches the build's warning.
  expect(warn.mock.calls.length).toBe(warned + 1)
  vi.mocked(h.db.db.prepare).mockRestore()
  const fourth = h.worker(3)
  expect(h.located(`dispatch:${fourth.id}`)).toBe(pane('tab-3'))
  expect(h.located(`dispatch:${unaffected.id}`)).toBe(pane('tab-1'))
  expect(h.located(`orca_session_id:${chat}`)).toBeDefined()
  expect(h.projection.build().associations.some((r) => r.identity === `dispatch:${first.id}`)).toBe(
    false
  )
})

it('publishes one principal per paired peer and attachments only while their worker runs there', () => {
  const h = harness()
  const local = h.worker(0)
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
  const prepare = h.db.db.prepare.bind(h.db.db)
  const failed = vi.spyOn(h.db.db, 'prepare').mockImplementation((sql: string) => {
    if (sql === AGENT_SENDER_PANE_READS.resources) {
      throw new Error('disk I/O error')
    }
    return prepare(sql)
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.ptys[0].launchToken = null
  h.ptys[0].launchIncarnationId = null
  const safe = h.projection.build('workspace')
  expect(safe.associations.some((row) => row.identity === `dispatch:${local.id}`)).toBe(false)
  expect(safe.attachments).toEqual([attached])
  expect(safe.principals).toEqual(publicRows.principals)
  expect(safe.peerFingerprint).toBe(publicRows.peerFingerprint)
  expect(safe.associations.some((row) => row.identity === handle(0))).toBe(true)
  failed.mockRestore()
  // A settled attachment no longer names a worker running there.
  h.db.db.prepare("UPDATE remote_dispatch_attachments SET state = 'stopped'").run()
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

it('publishes WSL chats, and only open chats when no tab table is recorded yet', () => {
  const record = (sessionId: string, wslDistro: string | null = null) => {
    const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
    return agentSessionConversationView({ ...base, location: { ...base.location, wslDistro } })
  }
  for (const history of [100, 1000]) {
    const rows = [
      record('wsl-chat', 'Ubuntu'),
      ...Array.from({ length: history }, (_, i) => record(`closed-${i}`))
    ]
    const h = harness(0, {
      getRecord: (id) => rows.find((r) => r.sessionId === id) ?? null,
      listRecords: () => rows,
      // Before the tab table exists the store answers from the workspace's saved chat tabs.
      getVisibleSessionTabIndex: () => ({ present: false, sessionIds: [] }),
      listVisibleSessionIds: () => ['wsl-chat']
    })
    expect(h.projection.build().associations.map((r) => r.identity)).toEqual([
      'orca_session_id:wsl-chat'
    ])
  }
})
