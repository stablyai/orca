import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-types'
import { startLocalWorker } from './local-worker-start'
import { decideWorkerStartMode } from '../../orchestration-worker-start-mode'

vi.mock('../runs/dispatch-creator', () => ({ resolveDispatchCreator: () => ({ kind: 'system' }) }))
vi.mock('../../../../orchestration/preamble', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  buildDispatchPreamble: () => 'the complete task'
}))

let database: OrchestrationDb | undefined
afterEach(() => {
  database?.close()
  database = undefined
  vi.useRealTimers()
})

it.each(['agent', 'shell'] as const)(
  'keeps the guarded worker continuation after caller timeout: %s',
  async (foreground) => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    database = db
    const physical = Promise.withResolvers<RuntimeTerminalCreate>()
    const pending = {
      operationId: 'operation',
      fingerprint: 'fingerprint',
      daemonGeneration: 'daemon',
      reservationGeneration: 'reservation',
      worktreeId: 'wt_new'
    }
    const deliveries: string[] = []
    const runtime = {
      showTerminal: async () => ({ worktreeId: 'wt_coord' }),
      showManagedWorktree: async () => ({ id: 'wt_coord', repoId: 'repo' }),
      showRepo: async () => ({ id: 'repo', path: '/work', kind: 'git' }),
      validateOrchestrationAgentLauncher: () => {},
      getNestedWorkerMaxDepth: () => 3,
      getRuntimeId: () => 'runtime',
      getOrchestrationHeartbeatMinutes: () => 5,
      getTerminalOrchestrationCliCommand: () => 'orca',
      getTerminalProcessIncarnation: () => 'agent:incarnation',
      getOrchestrationDispatchAuthority: () => ({
        paneKey: 'tab_agent:88888888-8888-4888-8888-888888888888',
        processIncarnation: 'agent:incarnation',
        hostScope: { kind: 'local', hostId: 'local' }
      }),
      createManagedWorktree: async () => ({
        worktree: { id: 'wt_new', repoId: 'repo' },
        startupTerminal: { spawned: false, pending },
        setupReceipt: { hookFound: true, startupPolicy: 'wait-for-setup', state: 'running' }
      }),
      waitForPreparedAgentTerminal: () => physical.promise,
      listTerminals: async () => ({
        terminals: [{ handle: 'term_agent', tabId: 'tab_agent', leafId: randomUUID() }]
      }),
      waitForFreshWorkerComposer: async () => ({ satisfied: true, status: 'matched' }),
      waitForTerminal: async () => ({ satisfied: true, status: 'matched' }),
      subscribeToTerminalData: () => () => {},
      readLaunchedAgentForeground: async () => foreground,
      launchedAgentHostProvesAgent: () => true,
      sendTerminalAgentPrompt: async (
        _handle: string,
        body: string,
        options: { beforeWrite?: (id: string) => Promise<void> }
      ) => {
        await options.beforeWrite?.('agent')
        deliveries.push(body)
        return {}
      },
      waitForSetupTerminalCompletion: async () => ({ exitCode: 0 })
    }
    const receipt = startLocalWorker({
      params: {
        from: 'term_coord',
        spec: 'do the complete task',
        agent: 'codex',
        worktree: 'new-child',
        name: 'child',
        timeoutMs: 20
      },
      // SAFETY: the real placement, readiness, write guard and settlement exercise only these runtime ports.
      runtime: runtime as unknown as OrcaRuntimeService,
      db,
      run: db.getRun('run_legacy_local')!,
      coordinator: null,
      mode: decideWorkerStartMode({ params: { agent: 'codex' }, settings: null })
    })
    await vi.advanceTimersByTimeAsync(30)
    const result = await receipt
    expect(result).toMatchObject({ state: 'outcome_unknown', pending })
    if (
      !result ||
      typeof result !== 'object' ||
      !('dispatchId' in result) ||
      typeof result.dispatchId !== 'string'
    ) {
      throw new Error('missing dispatch')
    }
    const dispatch = { id: result.dispatchId }
    expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('starting')
    expect(deliveries).toEqual([])
    physical.resolve({ handle: 'term_agent', worktreeId: 'wt_new', ptyId: 'agent', title: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: foreground === 'agent' ? 'ready' : 'failed',
      last_error: foreground === 'agent' ? null : expect.any(String)
    })
    expect(deliveries).toEqual(foreground === 'agent' ? ['the complete task'] : [])
    expect(db.getWorkerDispatch(dispatch.id)?.state).toBe(
      foreground === 'agent' ? 'ready' : 'failed'
    )
  }
)
