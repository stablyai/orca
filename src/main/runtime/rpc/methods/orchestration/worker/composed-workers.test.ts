import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import '../../../../../../shared/constants'
import '../../../../orchestration/workers/launch/worker-dispatch-preamble'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(withBoundRun = true): void {
    ;({ db, runtime, ctx } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  describe('composed workers', () => {
    function mockCurrentWorkerStart(options?: { ready?: boolean }): void {
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_coord'
          ? coordinatorPaneKey
          : handle === 'term_worker'
            ? 'tab_worker:leaf_worker'
            : null
      )
      vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
      vi.spyOn(runtime, 'showTerminal').mockImplementation(
        async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
      )
      vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
        id: 'repo::worktree'
      } as never)
      vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
        id: 'repo::worktree'
      } as never)
      vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'term_worker',
        worktreeId: 'repo::worktree',
        title: 'worker'
      })
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: options?.ready !== false,
        status: 'running',
        exitCode: null
      })
      vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
        handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
      )
      vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
      vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_worker',
        accepted: true,
        bytesWritten: 1
      })
    }

    it('rejects a declared caller that disagrees with complete attested evidence', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_coord' || handle === 'term_other'
          ? coordinatorPaneKey
          : handle === 'term_worker'
            ? 'tab_worker:leaf_worker'
            : null
      )
      const attestedEvidence = {
        terminalHandle: 'term_attested',
        paneKey: 'tab_attested:leaf_attested',
        launchToken: 'attested-launch-token'
      } as const
      vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
        terminalHandle: attestedEvidence.terminalHandle,
        paneKey: attestedEvidence.paneKey,
        processIncarnation: 'runtime_test:attested:1',
        launchTokenHash: 'attested-launch-token-hash',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      ctx = { ...ctx, orchestrationCompatibilityEvidence: attestedEvidence }
      const task = db.createTask({ spec: 'mismatched caller' })

      await expect(
        call('orchestration.workerStart', {
          task: task.id,
          from: 'term_other',
          agent: 'codex'
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(db.getDispatchContext(task.id)).toBeUndefined()
    })

    it('deliberately permits present but unverifiable restored-terminal evidence', async () => {
      setup()
      mockCurrentWorkerStart()
      // Restored/adopted terminals have no launch token; preserve intentional fail-open compatibility.
      const task = db.createTask({ spec: 'restored caller limitation' })
      ctx = {
        ...ctx,
        orchestrationCompatibilityEvidence: {
          terminalHandle: 'term_worker',
          paneKey: 'tab_worker:leaf_worker'
        }
      }

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { state: string }

      expect(result.state).toBe('ready')
      expect(db.getDispatchContext(task.id)).toBeDefined()
    })

    it('creates and binds a Run for an unbound coordinator, then names it on reuse', async () => {
      setup(false)
      mockCurrentWorkerStart()
      const start = () =>
        call('orchestration.workerStart', {
          spec: 'Audit the parser\nCheck every branch.',
          from: 'term_coord',
          agent: 'codex'
        })

      const first = await start()
      const bound = db.getCurrentRunForCoordinator({
        terminalHandle: 'term_coord',
        paneKey: coordinatorPaneKey,
        orcaSessionId: null
      })
      const run = { id: bound?.id, objective: 'Audit the parser' }
      expect(first).toMatchObject({ state: 'ready', run: { ...run, created: true } })
      expect(await start()).toMatchObject({ run: { ...run, created: false } })
    })

    it('puts overlapping first starts from an unbound coordinator in one Run', async () => {
      setup(false)
      mockCurrentWorkerStart()
      // Hold both starts in preflight, then let the second finish first.
      const preflights: (() => void)[] = []
      vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockImplementation(
        () =>
          new Promise((resolve) =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight reads only the workspace id.
            preflights.push(() => resolve({ id: 'repo::worktree' } as never))
          )
      )
      const start = (spec: string) =>
        call('orchestration.workerStart', { spec, from: 'term_coord', agent: 'codex' })

      const first = start('Audit the parser')
      const second = start('Audit the lexer')
      await vi.waitFor(() => expect(preflights).toHaveLength(2))
      preflights[1]()
      const secondReceipt = await second
      preflights[0]()
      const firstReceipt = await first

      const runs = db.listRuns().runs.filter((run) => run.legacy === 0)
      expect(runs).toHaveLength(1)
      expect(secondReceipt).toMatchObject({ run: { id: runs[0].id, created: true } })
      expect(firstReceipt).toMatchObject({ run: { id: runs[0].id, created: false } })
    })

    it('creates no Run when an unbound coordinator start fails preflight', async () => {
      setup(false)
      mockCurrentWorkerStart()

      await expect(
        call('orchestration.workerStart', {
          spec: 'Audit the parser',
          from: 'term_coord',
          agent: 'codex',
          worktree: 'new-child'
        })
      ).rejects.toThrow('repo_not_found')
      expect(db.listRuns().runs.filter((run) => run.legacy === 0)).toEqual([])
    })

    it('commits the launched worker token with its durable authority', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
        runtimeId: runtime.getRuntimeId(),
        terminalHandle: 'term_worker',
        ptyId: 'pty_worker',
        worktreeId: 'repo::worktree',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime_test:term_worker:1',
        launchTokenHash: 'worker-launch-token-hash',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      const task = db.createTask({ spec: 'persist worker identity' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { dispatchId: string }

      expect(db.getDispatchContextById(result.dispatchId)?.launch_token_hash).toBe(
        'worker-launch-token-hash'
      )
    })

    it('returns a failed receipt and preserves a created terminal as residual', async () => {
      setup()
      mockCurrentWorkerStart({ ready: false })
      const task = db.createTask({ spec: 'worker timeout' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { state: string; failedStage: string; residualResources: { id: string }[] }

      expect(result).toMatchObject({ state: 'failed', failedStage: 'agent_readiness' })
      expect(result.residualResources).toEqual([expect.objectContaining({ id: 'term_worker' })])
      expect(db.getTask(task.id)?.status).toBe('failed')
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    })
  })
})
