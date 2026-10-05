import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  createNewWorktreeWorkerFixture,
  type NewWorktreeWorkerFixture
} from './workers-new-worktree.test-support'

describe('a new-worktree worker with its brief offered to the agent-first launch line', () => {
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let startWorker: NewWorktreeWorkerFixture['startWorker']

  beforeEach(() => {
    ;({ db, runtime, startWorker } = createNewWorktreeWorkerFixture(coordinatorPaneKey))
  })

  afterEach(() => {
    db.close()
  })

  /** Agent-first creation, whose carry rule reports whether the brief rode the launch command. */
  function mockBriefCarryingWorktree(
    carried: boolean,
    options?: {
      startupPolicy?: 'start-immediately' | 'wait-for-setup'
      setupTerminalHandle?: string
    }
  ) {
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (args) => {
      args.onStartupPromptCarry?.(carried)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields worker-start reads are returned.
      return {
        worktree: { id: 'repo::created', repoId: 'repo' },
        startupTerminal: { spawned: true, handle: 'term_worker' },
        setupReceipt: {
          requested: 'run',
          hookFound: true,
          startupPolicy: options?.startupPolicy ?? 'start-immediately',
          state: 'running',
          terminalHandle: options?.setupTerminalHandle
        }
      } as never
    })
  }

  // Why: main spawns the agent first and provisions setup and tabs after it, with no extra shell.
  it('spawns the agent first with its brief on the line, and pastes nothing', async () => {
    mockBriefCarryingWorktree(true)

    const { result } = await startWorker({ worktree: 'new-top-level' })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        startupAgent: 'codex',
        startupLaunchSource: 'orchestration',
        startupTerminalHandle: 'term_worker',
        startupPromptPaste: 'once-agent-runs',
        startupPrompt: expect.stringContaining('--from term_worker')
      })
    )
    expect(vi.mocked(runtime.createManagedWorktree).mock.calls[0]?.[0].startupPrompt).toContain(
      'new-worktree task'
    )
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(runtime.observeTerminalLaunchTurnStart).toHaveBeenCalledWith(
      'term_worker',
      expect.objectContaining({ agent: 'codex', launchStartedAt: expect.any(Number) }),
      expect.any(Number),
      expect.any(AbortSignal)
    )
    expect(result).toMatchObject({ state: 'ready', turnStart: 'observed' })
  })

  // Why: a host the line cannot reach whole (a Windows shell, a relay WSL shell) gets main's paste.
  it('pastes the brief once the agent is ready where the line cannot carry it', async () => {
    mockBriefCarryingWorktree(false)

    const { result } = await startWorker()

    expect(runtime.observeTerminalLaunchTurnStart).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ state: 'ready' })
  })

  it('closes a startup terminal that came back under another handle than its brief names', async () => {
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (args) => {
      args.onStartupPromptCarry?.(true)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields worker-start reads are returned.
      return {
        worktree: { id: 'repo::created', repoId: 'repo' },
        startupTerminal: { spawned: true, handle: 'term_adopted' }
      } as never
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start reads no field of a close result.
    const close = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)

    const { result } = await startWorker()

    expect(result).toMatchObject({
      state: 'failed',
      lastError: 'Worker terminal did not keep its pre-allocated handle.'
    })
    expect(close).toHaveBeenCalledWith('term_adopted')
  })

  it("names the CLI command the new worktree's terminal will run", async () => {
    mockBriefCarryingWorktree(true)
    vi.mocked(runtime.predictOrchestrationCliCommandForSpawn).mockResolvedValue('orca-ide')

    await startWorker()

    expect(runtime.predictOrchestrationCliCommandForSpawn).toHaveBeenCalledWith({
      repoSelector: 'repo'
    })
    const prompt = vi.mocked(runtime.createManagedWorktree).mock.calls[0]?.[0].startupPrompt
    expect(prompt).toContain('orca-ide orchestration send')
    expect(prompt).not.toMatch(/(^|\s)orca orchestration send/)
  })

  it('fails the start at the setup gate when wait-for-setup fails behind the brief', async () => {
    mockBriefCarryingWorktree(true, {
      startupPolicy: 'wait-for-setup',
      setupTerminalHandle: 'term_setup'
    })
    vi.mocked(runtime.waitForSetupTerminalCompletion).mockResolvedValue({ exitCode: 1 })

    const { result } = await startWorker()

    expect(result).toMatchObject({ state: 'failed', failedStage: 'setup_wait' })
    expect(runtime.observeTerminalLaunchTurnStart).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  // Why: setup and the launched brief's turn start share the start's one budget, never T + T.
  it.each([
    [20_000, 40_000],
    [50_000, 30_000]
  ])(
    'after %i ms of setup, observes the launched turn for what is left (%i ms, never under 30 s)',
    async (setupMs, observationMs) => {
      mockBriefCarryingWorktree(true, {
        startupPolicy: 'wait-for-setup',
        setupTerminalHandle: 'term_setup'
      })
      let now = 1_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      vi.mocked(runtime.waitForSetupTerminalCompletion).mockImplementation(async () => {
        now += setupMs
        return { exitCode: 0 }
      })

      await startWorker({ timeoutMs: 60_000 })

      expect(runtime.observeTerminalLaunchTurnStart).toHaveBeenCalledWith(
        'term_worker',
        expect.anything(),
        observationMs,
        expect.any(AbortSignal)
      )
    }
  )
})
