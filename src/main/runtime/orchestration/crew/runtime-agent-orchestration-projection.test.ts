import 'node:fs'
import 'node:os'
import 'node:path'
import '../../agent-session/records/agent-session-record-store-test-harness'
import '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import '../../agent-session/records/agent-session-record-store-slot'
import '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import '../../orca-runtime'

import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import '../../rpc/orchestration-session-caller-test-fixture'
import '../../../../shared/orca-session-address'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import '../db/dispatch-predicate-visits.test-fixture'
import './runtime-agent-orchestration-benchmark.test-fixture'
import { MIRROR_LEAVES_STEP_1 } from '../../terminal/records/runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord } from '../../terminal/records/runtime-terminal-state-records'
import { OrchestrationDb } from '../db/orchestration-db'
import '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../terminal-authority/structured-sessions/structured-worker-identity'

const COORDINATOR_CHAT = testOrcaSessionId('1b6f0c3a-7d2e-4a91-8c55-2e9d4b7a0f13')
const WORKER_CHAT = testOrcaSessionId('9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48')
const TERMINAL_WORKER_HANDLE = 'term_worker'
const TERMINAL_WORKER_PANE = 'tab_w:11111111-1111-4111-8111-111111111111'

afterEach(() => vi.restoreAllMocks())

function chatRow(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

describe('RuntimeAgentOrchestrationProjection chat lineage', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
    hostRef.current = null
    vi.restoreAllMocks()
  })

  it('nests chat and terminal workers under the chat that dispatched them', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'chat run',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORDINATOR_CHAT
    })
    const chatWorker = {
      handle: mintStructuredWorkerHandle(),
      sessionId: WORKER_CHAT,
      paneKey: mintStructuredWorkerPaneKey(WORKER_CHAT)
    }
    const creator = { kind: 'session', orcaSessionId: COORDINATOR_CHAT } as const
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'chat worker' }).id,
      assigneeHandle: chatWorker.handle,
      assigneePaneKey: chatWorker.paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_CHAT),
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'terminal worker' }).id,
      assigneeHandle: TERMINAL_WORKER_HANDLE,
      assigneePaneKey: TERMINAL_WORKER_PANE,
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const leaf: RuntimeLeafRecord = { ...MIRROR_LEAVES_STEP_1[0], ptyId: 'pty_w' }
    const projection = new RuntimeAgentOrchestrationProjection({
      getDb: () => db,
      getLeaves: () => [leaf],
      getPtys: () => [],
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      issueLeafHandle: () => TERMINAL_WORKER_HANDLE,
      issuePtyHandle: () => '',
      makePaneKey: () => TERMINAL_WORKER_PANE,
      getWorktreeId: () => null,
      getHandleForPaneKey: () => null,
      getPaneKey: () => null,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getSessionRecords: () => null
    })

    const contexts = projection.buildByPaneKey()

    expect(contexts?.[chatRow(WORKER_CHAT)]?.parentPaneKey).toBe(chatRow(COORDINATOR_CHAT))
    expect(contexts?.[TERMINAL_WORKER_PANE]?.parentPaneKey).toBe(chatRow(COORDINATOR_CHAT))
    // The minted pane key authorizes the worker's mailbox; it must never reach a renderer.
    expect(JSON.stringify(contexts)).not.toContain(chatWorker.paneKey)
    expect(JSON.stringify(contexts)).not.toContain(chatWorker.handle)
  })
})
