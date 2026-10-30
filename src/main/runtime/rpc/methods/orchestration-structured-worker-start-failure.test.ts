import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { hostTestState } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
/** Post-create authority/preamble failure must retire both live and durable chat tabs; dropping only the dispatch hold restores an unowned dead tab after restart. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { structuredWorkerIdentities } from '../../structured-worker-identity'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => ({
    ok: true,
    value: { sessionId: args.envelope.sessionId }
  })
}))
vi.mock('./orchestration-structured-worker-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The realistic post-create failure: the session is live, the preamble turn is not acknowledged.
  sendStructuredWorkerPreamble: async () => {
    throw new Error('The dispatch preamble was rejected: no capacity')
  }
}))
vi.mock('./orchestration/worker/worker-start-validation', () => ({
  prepareLocalWorkerStart: () => ({
    agent: 'claude',
    launch: { receipt: { requested: null, effective: null }, preferences: undefined }
  })
}))
vi.mock('./orchestration/worker/worker-setup-gate', () => ({
  persistGatedSetupSpawnFailure: () => false,
  persistWorkerReadinessStage: () => {},
  persistWorkerSetupWaitOutcome: () => {}
}))
vi.mock('./orchestration/runs/dispatch-creator', () => ({
  resolveDispatchCreator: () => ({ kind: 'terminal', handle: 'term_c' })
}))
vi.mock('../../orchestration/preamble', () => ({ buildDispatchPreamble: () => 'preamble' }))

const { startLocalWorker } = await import('./orchestration/worker/local-worker-start')

const WORKTREE = 'wt_1'

function installHost() {
  const closed: string[] = []
  const visibility: [string, boolean][] = []
  const { host, store } = hostTestState()
  vi.spyOn(host, 'setSessionTabVisibility').mockImplementation(async (sessionId, visible) => {
    visibility.push([sessionId, visible])
  })
  vi.spyOn(host, 'close').mockImplementation(async (sessionId) => {
    closed.push(sessionId)
  })
  vi.spyOn(host, 'hasSession').mockImplementation((id) => !closed.includes(id))
  vi.spyOn(store, 'getConversation').mockImplementation((id) =>
    agentSessionConversationView(
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: id,
          claimStatus: closed.includes(id) ? 'released' : 'live',
          ownerProcess: null,
          reservedSpawnToken: null
        })
      )
    )
  )
  vi.spyOn(host, 'subscribe').mockResolvedValue(() => {})
  vi.spyOn(store, 'requireWritableRecord').mockImplementation((sessionId) =>
    agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId, runtimeFence: 1 }))
  )
  setStructuredAgentSessionHost(host)
  return { closed, visibility }
}

function fakes() {
  const retireStructuredAgentSessionTabFromSnapshot = vi.fn(() => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this partial runtime fixture implements the methods called by the failing start path.
  const runtime = {
    showTerminal: async () => ({ worktreeId: WORKTREE }),
    showManagedTerminalWorkspace: async () => ({ id: WORKTREE }),
    getNestedWorkerMaxDepth: () => 3,
    getOrchestrationHeartbeatMinutes: () => 5,
    getRuntimeId: () => 'epoch-1',
    ensureStructuredAgentSessionHost: async () => {},
    getTerminalOrchestrationCliCommand: () => 'orca',
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    getOrchestrationDispatchAuthority: () => ({
      paneKey: 'pane',
      processIncarnation: 'structured:x',
      hostScope: { kind: 'local', hostId: 'local' }
    }),
    forgetStructuredSessionMail: vi.fn(),
    validateOrchestrationAgentLauncher: vi.fn(),
    getTerminalProcessIncarnation: vi.fn(() => 'inc_1'),
    getTerminalPaneKey: vi.fn(() => 'pane_1'),
    retireStructuredAgentSessionTabFromSnapshot
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the failing start path calls only these methods.
  const db = {
    createStartingWorkerDispatch: () => ({
      dispatch: { id: 'd_fail', depth: 0 },
      task: { id: 't1', spec: 'do the thing' }
    }),
    recordWorkerStage: () => {},
    prepareStartingWorkerAuthority: () => {},
    getWorkerDispatch: () => undefined,
    failWorkerStart: (_dispatchId: string, stage: string) => ({
      state: 'failed',
      stage,
      effects: '[]',
      residual_resources: '[]'
    }),
    getWorkerTerminalResourceByOwner: () => undefined
  } as unknown as OrchestrationDb
  return { runtime, db, retireStructuredAgentSessionTabFromSnapshot }
}

beforeEach(() => {
  structuredWorkerIdentities.clear()
})

describe('a structured worker-start that fails after the session exists', () => {
  it('closes the session and retires the tab it published', async () => {
    const host = installHost()
    const { runtime, db, retireStructuredAgentSessionTabFromSnapshot } = fakes()

    const receipt = await startLocalWorker({
      params: { from: 'term_c', timeoutMs: 1_000, agent: 'claude' } as never,
      mode: {
        mode: 'structured',
        preferred: 'structured',
        reason: 'user_default',
        detail: 'structured by default'
      } as const,
      runtime,
      db,
      run: { id: 'run_1' } as never,
      existingTask: { id: 't1', spec: 'do the thing' } as never,
      coordinator: null,
      orchestrationMutation: undefined
    })

    expect(receipt).toMatchObject({ state: 'failed', stage: 'dispatch_input' })
    expect(host.closed).toHaveLength(1)
    const sessionId = host.closed[0] as string
    // Hide durable restore before retiring live state, or the dead tab returns next launch.
    expect(host.visibility).toContainEqual([sessionId, false])
    expect(retireStructuredAgentSessionTabFromSnapshot).toHaveBeenCalledWith(sessionId)
  })
})
