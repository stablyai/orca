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
import { releaseStructuredWorkerSession } from './orchestration-structured-worker-session'
import { isUnknownWorkerStartOutcome } from './orchestration/worker/worker-topology'
import type { OrchestrationDb } from '../../orchestration/db'
import { structuredWorkerIdentities } from '../../structured-worker-identity'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => ({
    ok: true,
    value: { sessionId: args.envelope.sessionId }
  })
}))
vi.mock('./orchestration/worker/worker-start-validation', () => ({
  prepareLocalWorkerStart: (args: { params: { agent: string } }) => ({
    agent: args.params.agent,
    launch: { receipt: { requested: null, effective: null }, preferences: undefined }
  })
}))
vi.mock('./orchestration/worker/worker-setup-gate', () => ({
  persistGatedSetupSpawnFailure: () => false,
  persistWorkerReadinessStage: () => {},
  persistWorkerSetupWaitOutcome: () => {}
}))
vi.mock('./orchestration/worker/worker-start-receipt', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  failWorkerStartWithReceipt: (args: { failedStage: string; error: unknown }) => ({
    state: isUnknownWorkerStartOutcome(args.error, args.failedStage) ? 'outcome_unknown' : 'failed',
    stage: args.failedStage
  })
}))
vi.mock('./orchestration/runs/dispatch-creator', () => ({
  resolveDispatchCreator: () => ({ kind: 'terminal', handle: 'term_c' })
}))
vi.mock('../../orchestration/preamble', () => ({ buildDispatchPreamble: () => 'preamble' }))

const { startLocalWorker } = await import('./orchestration/worker/local-worker-start')

const WORKTREE = 'wt_1'

function installHost(dispatchState = 'rejected') {
  const closed: string[] = []
  const visibility: [string, boolean][] = []
  const send = vi.fn(async () => ({
    ok: true,
    value: { submission: { dispatchState, reason: 'provider outcome' } }
  }))
  const release = vi.fn()
  const unsubscribe = vi.fn()
  const host = {
    send,
    setSessionTabVisibility: async (sessionId: string, visible: boolean) => {
      visibility.push([sessionId, visible])
    },
    close: async (sessionId: string) => {
      closed.push(sessionId)
    },
    hasSession: () => true,
    hold: async () => {},
    release,
    subscribe: () => unsubscribe,
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
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements every host member used by structured worker creation, dispatch and cleanup.
  setStructuredAgentSessionHost(host as never)
  return { closed, visibility, send, release, unsubscribe }
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
  const dbFixture = {
    createStartingWorkerDispatch: () => ({
      dispatch: { id: 'd_fail', depth: 0 },
      task: { id: 't1', spec: 'do the thing' }
    }),
    recordWorkerStage: () => {},
    prepareStartingWorkerAuthority: () => 'capability',
    getWorkerDispatch: () => ({ state: 'starting' }),
    markWorkerDispatchReady: () => ({ state: 'ready', stage: 'ready' })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the database calls reached by local worker start; receipt persistence is mocked.
  const db = dbFixture as unknown as OrchestrationDb
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

describe.each(['codex', 'claude'] as const)('%s structured worker admission', (agent) => {
  it.each(['pending', 'accepted', 'rejected', 'unknown'])(
    'preserves readiness and cleanup for %s',
    async (dispatchState) => {
      const host = installHost(dispatchState)
      const { runtime, db, retireStructuredAgentSessionTabFromSnapshot } = fakes()
      try {
        const receipt = await startLocalWorker({
          params: { from: 'term_c', timeoutMs: 1_000, agent },
          mode: {
            mode: 'structured',
            preferred: 'structured',
            reason: 'user_default',
            detail: 'structured by default'
          },
          runtime,
          db,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only id is read by this start fixture.
          run: { id: 'run_1' } as never,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only id and spec are read by this start fixture.
          existingTask: { id: 't1', spec: 'do the thing' } as never,
          coordinatorPane: null,
          orchestrationMutation: undefined
        })
        expect(host.send).toHaveBeenCalledTimes(1)
        if (dispatchState === 'pending' || dispatchState === 'accepted') {
          expect(receipt).toMatchObject({ state: 'ready', turnStart: 'unsupported' })
          expect(host.closed).toHaveLength(0)
          expect(host.release).not.toHaveBeenCalled()
          expect(host.unsubscribe).not.toHaveBeenCalled()
          expect(retireStructuredAgentSessionTabFromSnapshot).not.toHaveBeenCalled()
        } else {
          expect(receipt).toMatchObject({
            state: dispatchState === 'unknown' ? 'outcome_unknown' : 'failed',
            stage: 'dispatch_input'
          })
          expect(host.closed).toHaveLength(1)
          expect(host.release).toHaveBeenCalledTimes(1)
          expect(host.unsubscribe).toHaveBeenCalledTimes(1)
          expect(retireStructuredAgentSessionTabFromSnapshot).toHaveBeenCalledTimes(1)
        }
      } finally {
        releaseStructuredWorkerSession('d_fail', runtime)
      }
      expect(host.release).toHaveBeenCalledTimes(1)
      expect(host.unsubscribe).toHaveBeenCalledTimes(1)
    }
  )
})
