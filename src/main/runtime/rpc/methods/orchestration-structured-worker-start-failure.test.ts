/**
 * A worker start that fails AFTER its structured session exists is the fourth settlement path.
 *
 * The create publishes a "Claude Chat"/"Codex Chat" tab and writes it into the durable restore
 * index before the start can fail on the authority gate or on the preamble turn. Dropping only the
 * dispatch hold there left one dead tab per failed start, re-published on every app launch and
 * re-attaching a session no dispatch owns.
 */

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
vi.mock('./orchestration/worker/worker-start-receipt', () => ({
  failWorkerStartWithReceipt: (args: { failedStage: string }) => ({
    state: 'failed',
    stage: args.failedStage
  })
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
  setStructuredAgentSessionHost({
    setSessionTabVisibility: async (sessionId: string, visible: boolean) => {
      visibility.push([sessionId, visible])
    },
    close: async (sessionId: string) => {
      closed.push(sessionId)
    },
    hasSession: () => true,
    hold: async () => {},
    release: () => {},
    subscribe: () => () => {},
    deps: {
      store: {
        getRecord: () => ({
          location: { executionHostId: 'local', wslDistro: null },
          lease: {
            runtimeKind: 'native',
            claimStatus: 'live',
            deathEvidence: null,
            runtimeFence: 1
          }
        })
      }
    }
  } as never)
  return { closed, visibility }
}

function fakes() {
  const retireStructuredAgentSessionTabFromSnapshot = vi.fn(() => true)
  const runtime = {
    showTerminal: async () => ({ worktreeId: WORKTREE }),
    showManagedTerminalWorkspace: async () => ({ id: WORKTREE }),
    getNestedWorkerMaxDepth: () => 3,
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
  const db = {
    createStartingWorkerDispatch: () => ({
      dispatch: { id: 'd_fail', depth: 0 },
      task: { id: 't1', spec: 'do the thing' }
    }),
    recordWorkerStage: () => {},
    prepareStartingWorkerAuthority: () => 'capability'
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
      coordinatorPane: null,
      orchestrationMutation: undefined
    })

    expect(receipt).toMatchObject({ state: 'failed', stage: 'dispatch_input' })
    expect(host.closed).toHaveLength(1)
    const sessionId = host.closed[0] as string
    // Durable restore index first, then the live snapshot; without both, the dead tab comes back
    // on the next launch.
    expect(host.visibility).toContainEqual([sessionId, false])
    expect(retireStructuredAgentSessionTabFromSnapshot).toHaveBeenCalledWith(sessionId)
  })
})
