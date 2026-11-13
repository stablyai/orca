// Chat-mode workers have no terminal hook stream; worker-list must read the structured host's own verdict.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../../../../../shared/agent-session/lifecycle/agent-session-record'
import type { FleetAgentStatusEvidence } from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'

const hostRef: { current: unknown } = { current: null }

vi.mock(
  '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => hostRef.current })
)

const { projectWorkerFleet } = await import('../fleet/worker-list-projection')
const { createSessionWorkerLivenessReader } =
  await import('../../../../../orchestration/workers/lifecycle/session-worker-liveness')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} =
  await import('../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity')

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const NOW = 10 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

function record(
  provider: 'codex' | 'claude',
  lease: Partial<AgentSessionRecord['lease']> = {}
): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: SESSION, ...lease })),
    provider
  }
}

function installHost(current: AgentSessionRecord, attached: boolean) {
  hostRef.current = {
    deps: {
      store: {
        getConversation: () => agentSessionConversationView(current),
        listConversations: () => [agentSessionConversationView(current)],
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [SESSION] })
      }
    },
    getSessionTabId: () => `agent-session:${SESSION}`,
    hasSession: () => attached
  }
}

/** The session's own status row, as the structured status feed publishes it. */
function sessionStatus(
  state: FleetAgentStatusEvidence['activity']['state'],
  at: number
): FleetAgentStatusEvidence {
  return {
    binding: { kind: 'unresolved', reason: 'pane_not_bound' },
    clock: { kind: 'observed', at },
    deliveredAt: at,
    activity: {
      paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId(SESSION), SESSION),
      connectionId: null,
      state,
      agentType: 'codex',
      model: null,
      worktreeId: 'wt_1',
      restoredUnconfirmed: false,
      providerSessionOnly: false
    }
  }
}

describe('worker-list liveness for chat-mode workers', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })
  afterEach(() => db.close())

  function seed() {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'structured work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: mintStructuredWorkerHandle(),
      paneKey: mintStructuredWorkerPaneKey(SESSION),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION),
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'not_configured',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return dispatch.id
  }

  function project(statuses: FleetAgentStatusEvidence[]) {
    const dispatchId = seed()
    const rows = db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 })
    return projectWorkerFleet({
      rows,
      attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], NOW),
      statuses,
      limit: 1,
      now: NOW,
      observeSession: createSessionWorkerLivenessReader(db, statuses)
    }).workers[0]!
  }

  it('keeps an idle Claude chat worker live after its last turn is hours old', () => {
    installHost(record('claude'), true)
    const worker = project([sessionStatus('done', NOW - 2 * HOUR)])

    expect(worker.liveness.verdict).toBe('live')
    expect(worker.stage.activity).toBe('done')
    expect(worker.attention.requiresAction).toBe(false)
  })
})
