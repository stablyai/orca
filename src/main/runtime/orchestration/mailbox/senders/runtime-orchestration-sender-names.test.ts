import { acceptedAnswerSender } from './accepted-answer-sender'

import { OrcaRuntimeService } from '../../../orca-runtime'

import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'

// Name senders from production-owned Dispatch tasks, mirrored workspace chat/terminal tabs and PTY records.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-record'

import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'

import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'

import '../../../../../shared/wsl-hook-relay-contract'
import { OrchestrationDb } from '../../db/orchestration-db'

import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import '../../workers/lifecycle/lifecycle-reconciliation'

import { RuntimeOrchestrationSenderNames } from './runtime-orchestration-sender-names'

import { structuredMailSource } from '../structured-mail/structured-mail-source'

import '../../../../../shared/agent-session/view/structured-agent-session-projection'
import '../../../rpc/methods/orchestration/worker/follow-up/worker-earlier-work'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const CHAT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const WORKTREE = 'repo_1::/work/tree'

type Session = NonNullable<
  ReturnType<
    ConstructorParameters<typeof RuntimeOrchestrationSenderNames>[0]['getWorkspaceSession']
  >
>
type SenderNamingDeps = ConstructorParameters<typeof RuntimeOrchestrationSenderNames>[0]
type HookRow = NonNullable<ReturnType<SenderNamingDeps['getAgentStatusSnapshotForPane']>>[number]

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
    getHandleRecord: (handle) => {
      return handle === 'term_worker' || handle === 'term_plain'
        ? { worktreeId: WORKTREE, tabId: `tab_${handle}`, ptyId: `pty_${handle}` }
        : undefined
    },
    getPtyAgents: () => pty,
    getTerminalPaneKey: (handle) => `tab_${handle}:leaf`,
    getWorkspaceSession: (worktreeId) => (worktreeId === WORKTREE ? session : undefined),
    getGeneratedTitlesEnabled: () => generatedTitles,
    getAgentStatusSnapshotForPane: (paneKey) => hookRows.filter((row) => row.paneKey === paneKey),
    getTrackedTitle: () => trackedTitle
  })
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
      store: {
        getConversation: (id: string) => {
          const record = records.get(id)
          return record ? agentSessionConversationView(record) : null
        },
        listConversations: () => []
      }
    }
  }
})

afterEach(() => {
  db.close()
})

it('keeps the accepted answer actor after A parks and B adopts the same Run', () => {
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const run = db.createRun({
    objective: 'A owns this',
    coordinatorHandle: 'term_a',
    coordinatorPaneKey: 'tab_a:leaf',
    coordinatorOrcaSessionId: CHAT
  })
  const task = db.createTask({ runId: run.id, spec: 'Worker asks' })
  const dispatch = createRootDispatch(db, task.id, 'term_worker')
  const question = db.createQuestion({
    runId: run.id,
    dispatchId: dispatch.id,
    askerHandle: 'term_worker',
    question: 'Proceed?'
  })
  const snapshot = vi
    .spyOn(runtime.orchestrationSenderNames, 'snapshotOf')
    .mockImplementation((party) =>
      party.address === 'term_a_new'
        ? { name: 'Known A', agent: 'codex' }
        : { name: 'Wrong stored actor', agent: 'claude' }
    )
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_a:leaf')
  const answer = db.answerQuestion({
    messageId: question.message.id,
    runId: run.id,
    body: 'yes',
    consumerGeneration: run.consumer_generation,
    captureSender: acceptedAnswerSender(runtime, `run:${run.id}`, {
      address: 'term_a_new',
      terminalHandle: 'term_a_new',
      paneKey: 'tab_a:leaf',
      orcaSessionId: null
    })
  })
  const next = db.createRun({
    objective: 'A parks here',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  db.bindRun({ runId: next.id, coordinatorHandle: 'term_a_new', coordinatorPaneKey: 'tab_a:leaf' })
  db.bindRun({ runId: run.id, coordinatorHandle: 'term_b', coordinatorPaneKey: 'tab_b:leaf' })
  snapshot.mockReturnValue({ name: 'Known B', agent: 'claude' })
  const delivered = structuredMailSource({
    db,
    mailboxHandle: `dispatch:${dispatch.id}`,
    dispatchId: dispatch.id,
    batch: [db.getMessageById(answer.message.id)!],
    senderSnapshot: (party) => runtime.orchestrationSenderNames.snapshotOf(party)
  })
  expect(delivered.senders[0]).toMatchObject({
    name: 'Known A',
    agent: 'codex',
    party: { address: `run:${run.id}`, terminalHandle: null, orcaSessionId: null }
  })
  snapshot.mockRestore()
})

it('uses exact saved custody for follow-up dispatch identity and refuses a later process in the same pane', () => {
  const run = db.createRun({
    objective: 'reuse',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: null
  })
  const start = (agent?: string) => {
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 8,
      taskId: task.id,
      startOptions: agent ? { agent } : {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_term_worker:leaf',
      processIncarnation: 'p:1',
      worktreeId: WORKTREE,
      effects: [],
      setupState: 'not_applicable'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return db.getDispatchContextById(started.dispatch.id)!
  }
  const first = start('codex')
  const resource =
    db.getWorkerTerminalResourceByOwner(first.id) ??
    db.createWorkerTerminalResourceStatement({
      dispatchId: first.id,
      terminalHandle: 'term_worker',
      paneKey: 'tab_term_worker:leaf',
      processIncarnation: 'p:1',
      worktreeId: WORKTREE,
      ownership: 'owned'
    })
  db.completeDispatch(first.id)
  const next = start()
  db.transferWorkerTerminalResourceStatement({
    resourceId: resource.id,
    toDispatchId: next.id,
    terminalHandle: 'term_worker',
    paneKey: 'tab_term_worker:leaf',
    processIncarnation: 'p:1',
    hostScope: null
  })
  pty = { foregroundAgent: 'claude' }
  expect(names().sender(`dispatch:${next.id}`)).toMatchObject({
    agent: 'codex',
    party: { terminalHandle: null }
  })
  db.db
    .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
    .run('p:2', next.id)
  expect(names().sender(`dispatch:${next.id}`).agent).toBeUndefined()
})

it('names an exposed selected row without reading dormant tab getters', () => {
  const dormant = { id: 'tab_dormant' }
  Object.defineProperty(dormant, 'aiVaultTitle', {
    enumerable: true,
    get() {
      throw new Error('dormant getter read')
    }
  })
  session = { tabsByWorktree: { [WORKTREE]: [{ id: 'tab_selected', title: 'Selected' }, dormant] } }
  const name = names().agentRowNamer()
  expect(
    name({
      tabId: 'tab_selected',
      worktreeId: WORKTREE,
      ptyId: null,
      paneKey: null,
      agentType: 'codex',
      providerSessionId: undefined
    })
  ).toBe('Selected')
})
