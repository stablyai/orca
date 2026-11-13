// Chat-mode workers have no terminal hook stream; worker-list must read the structured host's own verdict.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionAdvisoryPolicyFingerprint } from '../../../../../../../shared/agent-session/agent-session-advisory-policy'
import type { FleetAgentStatusEvidence } from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../../../../core'
import { ORCHESTRATION_WORKER_CONTROL_METHODS } from '../worker-control'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../../../../agent-session/records/agent-session-execution-runtime', () => ({
  executionBuildHash: '0123456789abcdef'
}))

vi.mock(
  '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => hostRef.current })
)

const { projectWorkerFleet } = await import('../fleet/worker-list-projection')
const { readStructuredWorkerSettings } = await import('./session-worker-observation')
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
  const host = {
    deps: {
      adapter: { readExecutionEvidence: async () => null },
      store: {
        getRecord: () => current,
        getConversation: () => agentSessionConversationView(current),
        listConversations: () => [agentSessionConversationView(current)],
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [SESSION] })
      }
    },
    getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [SESSION] }),
    getSessionTabId: () => `agent-session:${SESSION}`,
    hasSession: () => attached,
    readOptions: async () => ({ models: [], current: {} })
  }
  hostRef.current = host
  return host
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
  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function seed(advisoryPolicyFingerprint?: string) {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'structured work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: advisoryPolicyFingerprint ? { advisoryPolicyFingerprint } : {},
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

  it('exposes only option facts for the exact live worker without promoting saved choices', async () => {
    const dispatchId = seed()
    const host = installHost(record('claude'), true)
    host.readOptions = async () => ({
      models: [],
      transcriptPath: '/private/conversation',
      current: {
        model: 'next-model',
        reportedModel: 'running-model',
        effort: 'high',
        reportedEffort: 'medium',
        confirmed: ['permissionMode'],
        reportedPermissionMode: 'plan',
        defaulted: [],
        acceptedInputSources: { model: 'saved', effort: 'saved' }
      }
    })
    const runtime = { ensureStructuredAgentSessionHost: async () => {} }

    expect(await readStructuredWorkerSettings(runtime, db, dispatchId)).toEqual({
      kind: 'options',
      sessionId: SESSION,
      runtimeFence: 7,
      agent: 'claude',
      current: {
        model: 'next-model',
        reportedModel: 'running-model',
        effort: 'high',
        reportedEffort: 'medium',
        confirmed: ['permissionMode'],
        reportedPermissionMode: 'plan',
        defaulted: [],
        acceptedInputSources: { model: 'saved', effort: 'saved' }
      }
    })
  })

  it('includes setting facts through the detailed worker-show RPC while leaving ordinary reads unchanged', async () => {
    const dispatchId = seed()
    const host = installHost(record('codex'), true)
    host.readOptions = async () => ({
      models: [],
      current: { model: 'native-model', effort: 'medium' }
    })
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'getOrchestrationFleetAgentStatusSnapshot').mockReturnValue([])
    const method = eraseRpcMethods(ORCHESTRATION_WORKER_CONTROL_METHODS).find(
      (candidate) => candidate.name === 'orchestration.workerShow'
    )
    if (!method || isStreamingMethod(method)) {
      throw new Error('Missing worker-show')
    }

    expect(
      await method.handler(method.params?.parse({ dispatch: dispatchId, includeSettings: true }), {
        runtime
      })
    ).toMatchObject({
      settings: {
        kind: 'options',
        sessionId: SESSION,
        runtimeFence: 7,
        agent: 'codex',
        current: { model: 'native-model', effort: 'medium' }
      }
    })
    expect(
      await method.handler(method.params?.parse({ dispatch: dispatchId }), { runtime })
    ).not.toHaveProperty('settings')
  })

  it('discards settings when the child changes during the options read', async () => {
    const dispatchId = seed()
    const current = record('codex')
    const host = installHost(current, true)
    host.readOptions = async () => {
      current.lease.runtimeFence = 8
      return { models: [], current: { model: 'retired-child' } }
    }
    const runtime = { ensureStructuredAgentSessionHost: async () => {} }

    expect(await readStructuredWorkerSettings(runtime, db, dispatchId)).toEqual({
      kind: 'unknown',
      reason: 'identity_changed'
    })
  })

  it('reads a released advisor receipt without private artifacts or owner tokens, and refuses replaced bindings', async () => {
    const current = record('claude', {
      claimStatus: 'released',
      runtimeFence: 8,
      ownerProcess: null,
      reservedSpawnToken: null
    })
    current.schemaVersion = 3
    current.location.workspaceKind = 'folder'
    current.advisoryPolicy = {
      schema: 2,
      dataScope: 'published',
      sourcePin: 'a'.repeat(40),
      deadlineAt: 1800000120000,
      maxModelCalls: 4,
      binding: { accountFingerprint: `claude:${'b'.repeat(64)}`, model: 'fixture', effort: 'high' },
      artifacts: [{ path: 'note', text: 'private artifact body', sha256: 'c'.repeat(64) }]
    }
    const fingerprint = agentSessionAdvisoryPolicyFingerprint(current.advisoryPolicy)
    const dispatchId = seed(fingerprint)
    current.advisoryReceipt = {
      version: 1,
      spawnTokenHash: 'd'.repeat(64),
      runtime: { runtimeId: 'retired-runtime', pid: 4242, buildHash: '0123456789abcdef' },
      invalidated: false,
      turnCompleted: true,
      execution: {
        agent: 'claude',
        sessionId: SESSION,
        runtimeFence: 7,
        acquisitionGeneration: 'generation',
        observedAt: 1800000000000,
        binding: { ...current.advisoryPolicy.binding, plan: 'max' },
        bounded: {
          policyFingerprint: fingerprint,
          deadlineAt: 1800000120000,
          maxModelCalls: 4,
          modelCalls: 1,
          inputAdmitted: true,
          hooksApplied: true,
          callCounter: 'main-assistant-message-ids'
        }
      },
      closure: { root: 'exited', tree: 'exited', observedAt: 1800000001000 }
    }
    installHost(current, false)
    const runtime = {
      ensureStructuredAgentSessionHost: async () => {},
      getRuntimeId: () => 'current-runtime'
    }
    const result = await readStructuredWorkerSettings(runtime, db, dispatchId)
    expect(result).toMatchObject({
      kind: 'advisory-receipt',
      sessionId: SESSION,
      runtimeFence: 7,
      qualification: { metadata: null, receipt: { closure: { root: 'exited', tree: 'exited' } } }
    })
    expect(JSON.stringify(result)).not.toContain('spawnTokenHash')
    expect(JSON.stringify(result)).not.toContain('private artifact body')
    current.lease.runtimeFence = 9
    expect(await readStructuredWorkerSettings(runtime, db, dispatchId)).toEqual({
      kind: 'unknown',
      reason: 'identity_changed'
    })
    current.lease.runtimeFence = 8
    current.advisoryPolicy.binding.model = 'different'
    expect(await readStructuredWorkerSettings(runtime, db, dispatchId)).toEqual({
      kind: 'unknown',
      reason: 'identity_changed'
    })
  })

  it('discards native evidence when child ownership changes during the evidence read', async () => {
    const dispatchId = seed()
    const current = record('codex')
    const host = installHost(current, true)
    host.deps.adapter.readExecutionEvidence = async () => {
      current.lease.runtimeFence = 8
      return null
    }
    expect(
      await readStructuredWorkerSettings(
        { ensureStructuredAgentSessionHost: async () => {} },
        db,
        dispatchId
      )
    ).toEqual({ kind: 'unknown', reason: 'identity_changed' })
  })

  it('refuses bounded settings without the dispatch policy binding', async () => {
    const dispatchId = seed()
    const current = record('codex')
    current.executionPolicy = {
      schema: 1,
      sourcePin: 'a'.repeat(40),
      accountFingerprint: `codex:${'b'.repeat(64)}`,
      model: 'gpt-live',
      effort: 'low',
      access: 'read-only',
      deadlineAt: 1_800_000_120_000
    }
    installHost(current, true)
    expect(
      await readStructuredWorkerSettings(
        { ensureStructuredAgentSessionHost: async () => {} },
        db,
        dispatchId
      )
    ).toEqual({ kind: 'unknown', reason: 'identity_changed' })
  })

  it('discards settings when the runtime replaces the session host during the read', async () => {
    const dispatchId = seed()
    const host = installHost(record('codex'), true)
    host.readOptions = async () => {
      installHost(record('codex', { runtimeFence: 8 }), true)
      return { models: [], current: { reportedModel: 'retired-host' } }
    }
    const runtime = { ensureStructuredAgentSessionHost: async () => {} }

    expect(await readStructuredWorkerSettings(runtime, db, dispatchId)).toEqual({
      kind: 'unknown',
      reason: 'identity_changed'
    })
  })

  it('keeps at-rest and failed provider reads unknown', async () => {
    const dispatchId = seed()
    installHost(record('codex', { claimStatus: 'released' }), false)
    const runtime = { ensureStructuredAgentSessionHost: async () => {} }
    expect(await readStructuredWorkerSettings(runtime, db, dispatchId)).toEqual({
      kind: 'unknown',
      reason: 'not_live'
    })

    const host = installHost(record('codex'), true)
    host.readOptions = async () => {
      throw new Error('provider error with private account detail')
    }
    expect(await readStructuredWorkerSettings(runtime, db, dispatchId)).toEqual({
      kind: 'unknown',
      reason: 'read_failed'
    })
  })
})
