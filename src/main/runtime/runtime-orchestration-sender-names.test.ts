// A sender's name snapshot, read from the sources production fills: dispatch tasks in the
// orchestration database, the chat tabs and terminal tabs of the workspace session this host
// mirrors, and the terminal's own pty.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { reconcileLifecycleMessage } from './orchestration/lifecycle-reconciliation'
import { RuntimeOrchestrationSenderNames } from './runtime-orchestration-sender-names'
import { structuredMailSource } from './orchestration/structured-mail-source'
import type { MessageRow } from './orchestration/types'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const CHAT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const WORKTREE = 'repo_1::/work/tree'

type Session = NonNullable<
  ReturnType<
    ConstructorParameters<typeof RuntimeOrchestrationSenderNames>[0]['getWorkspaceSession']
  >
>
type SenderNamingDeps = ConstructorParameters<typeof RuntimeOrchestrationSenderNames>[0]
type HookRow = ReturnType<SenderNamingDeps['getAgentStatusSnapshotForPane']>[number]

let db: OrchestrationDb
let session: Session
let records: Map<string, AgentSessionRecord>
let generatedTitles: boolean
let hookRows: HookRow[]
let pty: NonNullable<ReturnType<SenderNamingDeps['getPtyAgents']>>
let trackedTitle: string | null

function names() {
  return new RuntimeOrchestrationSenderNames({
    getDb: () => db,
    getHandleRecord: (handle) =>
      handle === 'term_worker' || handle === 'term_plain'
        ? { worktreeId: WORKTREE, tabId: `tab_${handle}`, ptyId: `pty_${handle}` }
        : undefined,
    getPtyAgents: () => pty,
    getTerminalPaneKey: (handle) => `tab_${handle}:leaf`,
    getWorkspaceSession: (worktreeId) => (worktreeId === WORKTREE ? session : undefined),
    getGeneratedTitlesEnabled: () => generatedTitles,
    getAgentStatusSnapshotForPane: (paneKey) => hookRows.filter((row) => row.paneKey === paneKey),
    getTrackedTitle: () => trackedTitle
  })
}

/** A worker dispatched `spec` on its own terminal, as `worker-start` leaves it. */
function finishedWorker(spec: string, handle = 'term_worker') {
  const run = db.createRun({
    objective: 'o',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: null
  })
  const task = db.createTask({ runId: run.id, spec })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey: `tab_${handle}:leaf`,
    processIncarnation: 'p:1',
    worktreeId: WORKTREE,
    effects: [],
    setupState: 'not_applicable'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  return { runId: run.id, taskId: task.id, dispatchId: started.dispatch.id }
}

/** Mail from `term_worker`, from its pane; a report names its task and dispatch. */
function workerMessage(
  runId: string,
  type: 'worker_done' | 'status',
  report?: { taskId: string; dispatchId: string }
) {
  return db.insertMessage({
    from: 'term_worker',
    to: `run:${runId}`,
    subject: type,
    type,
    senderPaneKey: 'tab_term_worker:leaf',
    runId,
    ...(report ? { payload: JSON.stringify({ ...report, outcome: 'succeeded' }) } : {})
  })
}

/** The name the mail lane records for `term_worker` when it announces these messages. */
function announcedName(batch: MessageRow[]): string | null {
  const sources = names()
  return (
    structuredMailSource({
      db,
      mailboxHandle: 'run:r',
      dispatchId: null,
      batch,
      senderName: (party, reported) => sources.nameOf(party, reported)
    }).senders[0]?.name ?? null
  )
}

function chatTab(customLabel: string | null, label: string) {
  return { contentType: 'agent-session' as const, entityId: CHAT, customLabel, label }
}

function providerTitleTab(): NonNullable<Session['tabsByWorktree']>[string][number] {
  return {
    id: 'tab_term_plain',
    title: '',
    aiVaultTitle: { agent: 'claude', sessionId: 'current-session', title: 'Parser work' }
  }
}

function hookRow(overrides: Partial<HookRow> = {}): HookRow {
  return {
    paneKey: 'tab_term_plain:leaf',
    worktreeId: WORKTREE,
    agentType: 'claude',
    connectionId: null,
    launchToken: 'launch-current',
    receivedAt: 1,
    providerSession: { key: 'session_id', id: 'current-session' },
    ...overrides
  }
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  session = { unifiedTabs: {}, tabsByWorktree: {} }
  generatedTitles = false
  hookRows = []
  pty = { launchAgent: 'codex', connectionId: null, launchToken: 'launch-current' }
  trackedTitle = null
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: CHAT }))
  records = new Map([[CHAT, { ...base, location: { ...base.location, workspaceId: WORKTREE } }]])
  hostRef.current = {
    deps: {
      store: { getRecord: (id: string) => records.get(id) ?? null, listRecords: () => [] }
    }
  }
})

afterEach(() => {
  db.close()
})

const chatParty = { address: `orca_session_id:${CHAT}`, terminalHandle: null, orcaSessionId: CHAT }
const terminalParty = (handle: string) => ({
  address: handle,
  terminalHandle: handle,
  orcaSessionId: null
})

describe("a sender's name, from what Orca shows for it", () => {
  it("names a local worker by its active dispatch's task when its tab has no name of its own", () => {
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const task = db.createTask({
      runId: run.id,
      spec: 'Port the parser',
      displayName: 'Parser port'
    })
    createRootDispatch(db, task.id, 'term_worker')
    session.tabsByWorktree = { [WORKTREE]: [{ id: 'tab_term_worker', title: 'Codex ready' }] }
    expect(names().nameOf(terminalParty('term_worker'))).toBe('Parser port')
    // A name the person gave the worker's tab is the one they know it by.
    session.tabsByWorktree = { [WORKTREE]: [{ id: 'tab_term_worker', customTitle: 'Build tab' }] }
    expect(names().nameOf(terminalParty('term_worker'))).toBe('Build tab')
  })

  it('names a worker by its task after its own accepted worker_done settled that dispatch', () => {
    const { runId, taskId, dispatchId } = finishedWorker('build it')
    const report = workerMessage(runId, 'worker_done', { taskId, dispatchId })
    // Settled synchronously at send, before the mail lane names who it is from.
    expect(reconcileLifecycleMessage(db, report).action).toBe('completed')
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(announcedName([report])).toBe('build it')
  })

  it('never names a worker by a task it never ran, nor by work it finished long ago', () => {
    const { runId, taskId, dispatchId } = finishedWorker('task A')
    const report = workerMessage(runId, 'worker_done', { taskId, dispatchId })
    expect(reconcileLifecycleMessage(db, report).action).toBe('completed')
    // Its next message, unrelated to that finished task: no task names it.
    expect(announcedName([workerMessage(runId, 'status')])).toBe('Codex')
    // A second task dispatched to the same terminal fails before the worker runs it.
    const taskB = db.createTask({ runId, spec: 'task B' })
    const failed = createRootDispatch(db, taskB.id, 'term_worker')
    db.failDispatch(failed.id, 'delivery failed')
    expect(announcedName([workerMessage(runId, 'status')])).toBe('Codex')
  })

  it('never names a worker by a dispatch its report names that is not its own', () => {
    const other = finishedWorker('someone else', 'term_other')
    expect(announcedName([workerMessage(other.runId, 'worker_done', other)])).toBe('Codex')
  })

  it("names a chat by the label its tab shows, the person's rename first", () => {
    session.unifiedTabs = { [WORKTREE]: [chatTab(null, 'Fix the login flow')] }
    expect(names().nameOf(chatParty)).toBe('Fix the login flow')
    session.unifiedTabs = { [WORKTREE]: [chatTab('Auth chat', 'Fix the login flow')] }
    expect(names().nameOf(chatParty)).toBe('Auth chat')
  })

  it("names a chat by its saved name before its task or its tab's default label", () => {
    const record = records.get(CHAT)
    if (!record) {
      throw new Error('chat record missing')
    }
    records.set(CHAT, { ...record, conversationName: 'Port the lexer' })
    session.unifiedTabs = { [WORKTREE]: [chatTab(null, 'Claude Chat')] }
    expect(names().nameOf(chatParty)).toBe('Port the lexer')
  })

  it.each(['rename', 'saved name'])(
    'keeps a chat %s even when it equals the default label',
    (kind) => {
      const record = records.get(CHAT)
      if (!record) {
        throw new Error('chat record missing')
      }
      records.set(CHAT, {
        ...record,
        conversationName: kind === 'saved name' ? 'Claude Chat' : undefined
      })
      session.unifiedTabs = {
        [WORKTREE]: [chatTab(kind === 'rename' ? 'Claude Chat' : null, 'Claude Chat')]
      }
      const { dispatchId } = finishedWorker('Port the parser')
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
      expect(names().nameOf({ ...chatParty, terminalHandle: 'term_worker' })).toBe('Claude Chat')
    }
  )

  it("names a chat with no tab by its agent's chat label", () => {
    expect(names().nameOf(chatParty)).toBe('Claude Chat')
  })

  it("names a terminal agent as its sidebar row does: the tab's own name, else its agent", () => {
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Codex')
    session.tabsByWorktree = { [WORKTREE]: [{ id: 'tab_term_plain', customTitle: ' Lint ' }] }
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Lint')
    session.tabsByWorktree = {
      [WORKTREE]: [{ id: 'tab_term_plain', title: '✳ Fix the sender link' }]
    }
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Fix the sender link')
    // A status the agent paints is not a name.
    session.tabsByWorktree = { [WORKTREE]: [{ id: 'tab_term_plain', title: 'Codex ready' }] }
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Codex')
  })

  it('uses a generated tab title only while the person has generated titles on', () => {
    session.tabsByWorktree = {
      [WORKTREE]: [{ id: 'tab_term_plain', title: 'Codex ready', generatedTitle: 'Lint fixes' }]
    }
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Codex')
    generatedTitles = true
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Lint fixes')
  })

  it.each([
    { id: 'current-session', expected: 'Parser work' },
    { id: 'another-session', expected: 'Claude' },
    { id: undefined, expected: 'Claude' }
  ])('accepts a saved provider title only for the hook row session $id', ({ id, expected }) => {
    session.tabsByWorktree = { [WORKTREE]: [providerTitleTab()] }
    // The hook's current owner is Claude even though the PTY was launched as Codex.
    hookRows = [hookRow({ providerSession: id ? { key: 'session_id', id } : undefined })]
    expect(names().nameOf(terminalParty('term_plain'))).toBe(expected)
  })

  it.each<{ label: string; row: Partial<HookRow> }>([
    { label: 'another pane', row: { paneKey: 'tab_sibling:leaf' } },
    { label: 'another workspace', row: { worktreeId: 'folder:other' } },
    { label: 'another launch', row: { launchToken: 'launch-old' } },
    { label: 'another SSH host', row: { connectionId: 'ssh-other' } }
  ])('does not use a provider title from $label', ({ row }) => {
    session.tabsByWorktree = { [WORKTREE]: [providerTitleTab()] }
    hookRows = [hookRow(row)]
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Codex')
  })

  it('uses the newest owner row even when it has not reported a provider session', () => {
    session.tabsByWorktree = { [WORKTREE]: [providerTitleTab()] }
    hookRows = [hookRow(), hookRow({ receivedAt: 2, providerSession: undefined })]
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Claude')
  })

  it.each([
    { ptyConnection: 'ssh-current', rowConnection: 'ssh-current', expected: 'Parser work' },
    { ptyConnection: 'ssh-current', rowConnection: 'ssh-other', expected: 'Codex' },
    {
      ptyConnection: null,
      rowConnection: wslHookRelayConnectionId('Ubuntu'),
      expected: 'Parser work'
    },
    { ptyConnection: null, rowConnection: wslHookRelayConnectionId('Debian'), expected: 'Codex' }
  ])('selects provider identity only on its execution host: $rowConnection', (test) => {
    session.tabsByWorktree = { [WORKTREE]: [providerTitleTab()] }
    pty = { ...pty, connectionId: test.ptyConnection, wslDistro: 'Ubuntu' }
    hookRows = [hookRow({ connectionId: test.rowConnection })]
    expect(names().nameOf(terminalParty('term_plain'))).toBe(test.expected)
  })

  it('does not infer provider identity from the cached title without a status row', () => {
    session.tabsByWorktree = {
      [WORKTREE]: [
        {
          id: 'tab_term_plain',
          title: 'Codex ready',
          aiVaultTitle: { agent: 'codex', sessionId: 'old-session', title: 'Old task' }
        }
      ]
    }
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Codex')
  })

  it('names a single pane by its current title before its older mirrored tab title', () => {
    session.tabsByWorktree = {
      [WORKTREE]: [{ id: 'tab_term_plain', title: 'Old task' }]
    }
    trackedTitle = '✳ Current task'
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Current task')
  })

  it("never names a pane in a split tab by the tab title, which is its focused sibling's", () => {
    session.tabsByWorktree = { [WORKTREE]: [{ id: 'tab_term_plain', title: 'Sibling task' }] }
    session.terminalLayoutsByTabId = {
      tab_term_plain: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'a' },
          second: { type: 'leaf', leafId: 'b' }
        }
      }
    }
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Codex')
    trackedTitle = '✳ Own pane task'
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Own pane task')
  })

  it('names a party nothing records as nothing', () => {
    expect(names().nameOf(terminalParty('term_unknown'))).toBeNull()
  })

  it('builds the one sender a message records: its party and the name it has now', () => {
    session.unifiedTabs = { [WORKTREE]: [chatTab(null, 'Fix the login flow')] }
    expect(names().sender(`orca_session_id:${CHAT}`)).toEqual({
      party: { address: `orca_session_id:${CHAT}`, terminalHandle: null, orcaSessionId: CHAT },
      name: 'Fix the login flow'
    })
  })
})
