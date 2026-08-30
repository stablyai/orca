import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-types'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => void
  handleByPtyId: Map<string, string>
}

function runtimeInternals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

describe('orchestration worker readiness verdict', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let child: ChildProcess | undefined

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Readiness verdict oracle',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:pane_coord'
    }).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? 'tab_coord:pane_coord' : 'tab_worker:pane_worker'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime_test:worker:1')
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: 'repo::parent',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::parent',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_worker', title: 'Codex' }],
      totalCount: 1,
      truncated: false
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockReturnValue(
      new Promise(() => undefined)
    )
    vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::created', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    } as never)
  })

  afterEach(() => {
    if (child?.pid && child.exitCode === null) {
      child.kill()
    }
    child = undefined
    db.close()
    vi.useRealTimers()
  })

  async function startWorker(wait: Promise<RuntimeTerminalWait> | RuntimeTerminalWait) {
    const task = db.createTask({ spec: 'readiness oracle task', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    vi.mocked(runtime.waitForTerminal).mockImplementationOnce(async () => await wait)
    const result = await method.handler(
      method.params!.parse({
        task: task.id,
        from: 'term_coord',
        worktree: 'new-child',
        name: 'readiness-worker',
        agent: 'codex'
      }),
      { runtime }
    )
    return { result: result as Record<string, unknown>, task }
  }

  it('captures a live terminal at timeout instead of treating timeout as a dead launch', async () => {
    vi.useFakeTimers()
    vi.mocked(runtime.waitForTerminal).mockRestore()
    runtimeInternals(runtime).recordPtyWorktree('pty-worker', 'repo::created', { connected: true })
    runtimeInternals(runtime).handleByPtyId.set('pty-worker', 'term_worker')

    const waiting = runtime.waitForTerminal('term_worker', {
      condition: 'tui-idle',
      timeoutMs: 1
    })
    const rejected = waiting.catch((error: unknown) => error as Error & { terminalLive?: boolean })
    await vi.advanceTimersByTimeAsync(1)

    await expect(rejected).resolves.toMatchObject({
      message: 'timeout',
      terminalLive: true
    })
  })

  it('keeps a live process independently observable and leaves timeout reportable', async () => {
    const launched = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      stdio: 'ignore'
    })
    child = launched
    await new Promise<void>((resolve, reject) => {
      launched.once('spawn', () => resolve())
      launched.once('error', reject)
    })
    expect(launched.pid).toBeDefined()
    expect(() => process.kill(launched.pid!, 0)).not.toThrow()
    expect((await runtime.listTerminals()).terminals).toEqual(
      expect.arrayContaining([expect.objectContaining({ handle: 'term_worker' })])
    )

    const { result, task } = await startWorker(
      Promise.reject(
        Object.assign(new Error('timeout'), {
          code: 'terminal_wait_timeout',
          terminalLive: true
        })
      )
    )
    const dispatch = db.getDispatchContext(task.id)!
    const worker = db.getWorkerDispatch(dispatch.id)!

    expect(result).toMatchObject({ state: 'outcome_unknown', failedStage: 'agent_readiness' })
    expect(db.getTask(task.id)).toMatchObject({ status: 'blocked' })
    expect(dispatch).toMatchObject({ status: 'pending' })
    expect(dispatch.capability_revoked_at).not.toBeNull()
    expect(worker).toMatchObject({ state: 'start_unknown', stage: 'agent_readiness' })
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(() =>
      db.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: dispatch.id,
        startOptions: { worktree: 'new-child' },
        runtimeEpoch: runtime.getRuntimeId()
      })
    ).toThrowError(/cannot retry/)
  })

  it.each([
    {
      name: 'exited',
      wait: {
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: false,
        status: 'exited',
        exitCode: 1
      } satisfies RuntimeTerminalWait
    },
    {
      name: 'blocked',
      wait: {
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: false,
        status: 'running',
        exitCode: null,
        blockedReason: 'codex-trust-workspace'
      } satisfies RuntimeTerminalWait
    }
  ])('keeps genuine $name readiness verdicts failed', async ({ wait }) => {
    const { result, task } = await startWorker(wait)
    const dispatch = db.getDispatchContext(task.id)!
    const worker = db.getWorkerDispatch(dispatch.id)!

    expect(result).toMatchObject({ state: 'failed', failedStage: 'agent_readiness' })
    expect(db.getTask(task.id)).toMatchObject({ status: 'failed' })
    expect(dispatch).toMatchObject({ status: 'failed' })
    expect(dispatch.capability_revoked_at).not.toBeNull()
    expect(worker).toMatchObject({ state: 'failed', stage: 'agent_readiness' })
  })
})
