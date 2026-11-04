import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { readCapturedOrchestrationFleetAgentStatusSnapshot } from '../../orchestration-fleet-agent-status-snapshot'
import { RuntimeOrchestrationSenderNames } from '../../runtime-orchestration-sender-names'
import type { MirroredTabs } from '../orchestration-sender-name'
import { CrewChanges } from './crew-changes'
import { fixture } from './crew-read-model.test-fixture'

export const CREW_COST_CORPUS = {
  retainedConversations: 10_472,
  retainedMessages: 181_239,
  pendingQuestions: 31,
  statusRows: 172
} as const

export function crewRuntimeCostCorpus() {
  const f = fixture()
  const worker = f.assign('term_worker')
  for (let index = 1; index < CREW_COST_CORPUS.statusRows; index++) {
    f.handles.set(
      `term_cost_${index}`,
      `tab_cost_${index}:aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`
    )
  }
  const panes = new Map([...f.handles].map(([handle, pane]) => [pane, handle]))
  f.deps.handleForPane = (pane) => panes.get(pane) ?? null
  const records = Array.from({ length: CREW_COST_CORPUS.retainedConversations }, (_, index) =>
    agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId: testOrcaSessionId(`crew-cost-${index}`),
        conversationName: `Retained conversation ${index}`
      })
    )
  )
  const recordMap = new Map(records.map((record) => [record.sessionId, record]))
  f.deps.records = {
    listRecords: () => records,
    getRecord: (id) => recordMap.get(id) ?? null
  }
  // Populate old mailbox history in one statement; seeding is outside every measured interval.
  f.db.db
    .prepare(`WITH RECURSIVE history(n) AS (
      VALUES(1) UNION ALL SELECT n + 1 FROM history WHERE n < ?
    ) INSERT INTO messages(id, run_id, from_handle, to_handle, subject, body, type, created_at)
      SELECT 'cost-old-' || n, ?, 'term_old_' || (n % 119),
        CASE WHEN n % 3 = 0 THEN 'term_coord' ELSE 'term_cost_' || (n % 171 + 1) END,
        'Historical status', 'Retained old message', 'status', '2020-01-01 00:00:00'
      FROM history`)
    .run(CREW_COST_CORPUS.retainedMessages - CREW_COST_CORPUS.pendingQuestions, f.run.id)
  for (let index = 0; index < CREW_COST_CORPUS.pendingQuestions; index++) {
    f.db.createQuestion({
      runId: f.run.id,
      dispatchId: worker.id,
      askerHandle: 'term_worker',
      question: `Pending decision ${index}`
    })
  }
  const now = Date.now()
  const raw: AgentStatusIpcPayload[] = [...f.handles]
    .filter(([handle]) => handle === 'term_worker' || handle.startsWith('term_cost_'))
    .map(([, paneKey]) => ({
      paneKey,
      state: 'working',
      agentType: 'codex',
      prompt: '',
      connectionId: null,
      receivedAt: now,
      stateStartedAt: now
    }))
  const counters = { statusAcquisitions: 0, dependencyAcquisitions: 0 }
  const acquireStatus = () => {
    counters.statusAcquisitions++
    return readCapturedOrchestrationFleetAgentStatusSnapshot(
      {
        getAgentStatusSnapshotFn: () => raw,
        readObservedAgentStatusPaneIdentityFn: () => ({ kind: 'unobserved' }),
        getAgentStatusTerminalHandleForPaneKey: (pane) => panes.get(pane),
        getTerminalProcessIncarnation: () => 'cost-process'
      },
      {
        getDb: () => f.db,
        getLeaves: () => [],
        getPtys: () => [],
        paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
        issueLeafHandle: () => '',
        issuePtyHandle: () => '',
        makePaneKey: () => '',
        getWorktreeId: () => null,
        getHandleForPaneKey: f.deps.handleForPane,
        getPaneKey: f.deps.paneForHandle,
        getDispatchAuthority: () => null,
        getAgentStatusSnapshot: () => [],
        getSessionRecords: () => f.deps.records
      }
    )
  }
  let workspace: MirroredTabs & { costIrrelevantWorkspaceState: string }
  const setWorkspaceBytes = (bytes: number) => {
    workspace = {
      tabsByWorktree: {
        folder: [
          { id: 'tab_worker', title: 'Initial worker title', customTitle: 'Initial worker name' }
        ]
      },
      costIrrelevantWorkspaceState: ''
    }
    workspace.costIrrelevantWorkspaceState = 'x'.repeat(
      bytes - Buffer.byteLength(JSON.stringify(workspace))
    )
  }
  setWorkspaceBytes(4_064_436)
  const names = new RuntimeOrchestrationSenderNames({
    getDb: () => f.db,
    getHandleRecord: (handle) =>
      handle === 'term_worker'
        ? { worktreeId: 'folder', tabId: 'tab_worker', ptyId: 'pty_cost_worker' }
        : undefined,
    getPtyAgents: () => ({ launchAgent: 'codex' }),
    getTerminalPaneKey: f.deps.paneForHandle,
    getWorkspaceSession: () => workspace,
    getGeneratedTitlesEnabled: () => true,
    getAgentStatusSnapshot: () => raw,
    getAgentStatusSnapshotForPane: (pane) => raw.filter((row) => row.paneKey === pane),
    getTrackedTitle: () => null
  })
  const changes = new CrewChanges()
  const watch = (wake: Parameters<typeof changes.subscribe>[0]) => {
    const stops = [changes.subscribe(wake), f.db.crewChanges.subscribe(wake)]
    return () => stops.forEach((stop) => stop())
  }
  let revision = 0
  let expectedName = 'Initial worker name'
  let expectedState: 'working' | 'waiting' = 'working'
  const actions = {
    names: () => {
      expectedName = `Renamed worker ${++revision}`
      workspace.tabsByWorktree!.folder[0].customTitle = expectedName
      changes.notify(new Set(['names']))
    },
    status: () => {
      expectedState = expectedState === 'working' ? 'waiting' : 'working'
      raw[0] = { ...raw[0], state: expectedState }
      changes.notify(new Set(['status']))
    },
    traffic: () => {
      const body = `New peer status ${++revision}`
      f.db.insertMessage({
        runId: f.run.id,
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Status',
        body
      })
      return body
    },
    topology: () => changes.notify(new Set(['topology']))
  }
  return {
    ...f,
    counters,
    actions,
    changes,
    watch,
    setWorkspaceBytes,
    expectedName: () => expectedName,
    expectedState: () => expectedState,
    workspaceBytes: () => Buffer.byteLength(JSON.stringify(workspace)),
    recordBytes: Buffer.byteLength(JSON.stringify(records)),
    addresses: (count: number) => [
      'term_coord',
      ...records.slice(0, count - 1).map((record) => {
        if (!isOrcaSessionId(record.sessionId)) {
          throw new Error(`Not an Orca session id: ${record.sessionId}`)
        }
        return formatOrcaSessionAddress(record.sessionId)
      })
    ],
    dependencies: () => {
      counters.dependencyAcquisitions++
      return {
        ...f.deps,
        name: names.captureCrewInputs(),
        get statuses() {
          return acquireStatus()
        }
      }
    }
  }
}
