import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import './orca-runtime-test-lifecycle.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'

const SESSION = { key: 'session_id', id: 'grok-session-1' } as const
const DEAD_PANE_KEY = 'crashed-reopen-tab:44444444-4444-4444-8444-444444444444'

describe('worker terminal recovery after a crash', () => {
  it('lets the conversation of a worker whose terminal died with Orca be reopened', async () => {
    // A restored hook row from before the crash; this agent reports no process to probe.
    const hookRows = new Map<string, AgentStatusIpcPayload>([
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume guards read only paneKey, providerSession and the observation clocks.
      [DEAD_PANE_KEY, { paneKey: DEAD_PANE_KEY, providerSession: SESSION, receivedAt: 1 } as never]
    ])
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow: vi.fn() }),
      undefined,
      {
        canRecoverPersistentLocalPtys: () => true,
        getDesktopWindowStatus: () => 'openable',
        getAgentProviderSessionSnapshot: () => [...hookRows.values()],
        checkHookAgentPresence: async () => null,
        reconcileAgentStatusForEndedProcess: (paneKeys) => {
          for (const paneKey of paneKeys) {
            hookRows.delete(paneKey)
          }
        }
      }
    )
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'crash',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: 'tab_c:leaf_c'
      })
      const task = db.createTask({ spec: 'follow up', runId: run.id })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'grok' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_crashed_reopen',
        paneKey: DEAD_PANE_KEY,
        processIncarnation: 'pty-crashed:55555555-5555-4555-8555-555555555555',
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        spawn: vi.fn(async () => ({ id: 'resumed-pty' })),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        hasPty: () => false,
        listProcesses: async () => []
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery calls only this notifier method.
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery: vi.fn() } as never)

      await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
        exitedDispatchIds: [started.dispatch.id]
      })

      await expect(
        runtime.resumeAgentSessionInWorkspace(TEST_WORKTREE_ID, {
          agent: 'grok',
          providerSession: SESSION,
          captureHostId: 'local',
          mutationId: 'next-follow-up'
        })
      ).resolves.toMatchObject({ ok: true })
    } finally {
      db.close()
    }
  })
})
