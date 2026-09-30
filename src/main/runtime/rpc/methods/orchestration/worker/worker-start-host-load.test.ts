import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_LOAD_EXCEEDED_CODE,
  HOST_LOAD_EXCEEDED_NEXT_STEPS
} from '../../../../../../shared/host-load-gate'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('worker-start --max-load host load gate', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  const idleCore: os.CpuInfo = {
    model: 'test',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  }

  function mockHostLoad(loadAverage1m: number, cores: number): void {
    vi.spyOn(os, 'loadavg').mockReturnValue([loadAverage1m, 0, 0])
    vi.spyOn(os, 'cpus').mockReturnValue(Array.from({ length: cores }, () => idleCore))
  }

  function mockSshWorktree(): void {
    vi.mocked(harness.runtime.showManagedTerminalWorkspace).mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo',
      hostId: 'ssh:build-box'
    })
  }

  function mockLegacyWorktree(): void {
    vi.mocked(harness.runtime.showManagedTerminalWorkspace).mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo'
    })
  }

  function repoRow(overrides: {
    id: string
    connectionId?: string
    executionHostId?: `ssh:${string}` | `runtime:${string}` | 'local'
  }) {
    return {
      path: '/remote/worktree',
      displayName: 'repo',
      badgeColor: '#000000',
      addedAt: 0,
      ...overrides
    }
  }

  async function startWithMaxLoad(maxLoad: number, extra: Record<string, unknown> = {}) {
    const task = harness.db.createTask({
      spec: 'heavy: integration tests',
      runId: harness.activeRunId
    })
    return {
      task,
      result: harness.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex',
        maxLoad,
        ...extra
      })
    }
  }

  it('refuses before creating any Dispatch while the per-core load is above the ratio', async () => {
    mockHostLoad(12, 8)
    const { task, result } = await startWithMaxLoad(0.7)

    await expect(result).rejects.toMatchObject({
      code: HOST_LOAD_EXCEEDED_CODE,
      message:
        'Host load 1.50 per core (1-minute average 12.00 on 8 cores) exceeds --max-load 0.7. No effects were applied.',
      data: {
        effectsApplied: false,
        cpuCoreCount: 8,
        loadAverage1m: 12,
        loadRatio: 1.5,
        maxLoad: 0.7,
        nextSteps: [...HOST_LOAD_EXCEEDED_NEXT_STEPS]
      }
    })
    expect(harness.db.getTask(task.id)?.status).toBe('ready')
    expect(
      harness.db.db
        .prepare('SELECT COUNT(*) AS rows FROM dispatch_contexts WHERE task_id = ?')
        .get(task.id)
    ).toEqual({ rows: 0 })
  })

  it('starts the worker once the per-core load is within the ratio', async () => {
    mockHostLoad(4, 8)
    const { task, result } = await startWithMaxLoad(0.7)

    await expect(result).resolves.toMatchObject({ taskId: task.id, state: 'ready' })
  })

  it('starts the worker without a gate when --max-load is omitted', async () => {
    mockHostLoad(64, 8)

    await expect(harness.startWorker()).resolves.toMatchObject({ dispatchId: expect.any(String) })
  })

  it('rejects the flag for a remote start instead of gating on the wrong host', async () => {
    mockHostLoad(0, 8)
    const { result } = await startWithMaxLoad(0.7, { on: 'build-box', worktree: 'new-top-level' })

    await expect(result).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--max-load gates workers on the Run home only; it cannot combine with --on.'
    })
  })

  it('refuses a worktree that runs on an SSH host without sampling the Run home load', async () => {
    const loadavg = vi.spyOn(os, 'loadavg')
    mockSshWorktree()
    const { task, result } = await startWithMaxLoad(0.7)

    await expect(result).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        "--max-load samples the Run home load only; the resolved worktree runs on ssh:build-box. Start the worker on that host's own Orca, or omit --max-load."
    })
    expect(loadavg).not.toHaveBeenCalled()
    expect(
      harness.db.db
        .prepare('SELECT COUNT(*) AS rows FROM dispatch_contexts WHERE task_id = ?')
        .get(task.id)
    ).toEqual({ rows: 0 })
  })

  it('refuses a legacy worktree whose only repo row carries an SSH connection', async () => {
    const loadavg = vi.spyOn(os, 'loadavg')
    mockLegacyWorktree()
    vi.spyOn(harness.runtime, 'listRepos').mockReturnValue([
      repoRow({ id: 'repo', connectionId: 'build-box' })
    ])
    const { task, result } = await startWithMaxLoad(0.7)

    await expect(result).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        "--max-load samples the Run home load only; the resolved worktree runs on ssh:build-box. Start the worker on that host's own Orca, or omit --max-load."
    })
    expect(loadavg).not.toHaveBeenCalled()
    expect(
      harness.db.db
        .prepare('SELECT COUNT(*) AS rows FROM dispatch_contexts WHERE task_id = ?')
        .get(task.id)
    ).toEqual({ rows: 0 })
  })

  it('refuses as ambiguous when rival same-id repo rows disagree about the host', async () => {
    const loadavg = vi.spyOn(os, 'loadavg')
    mockLegacyWorktree()
    vi.spyOn(harness.runtime, 'listRepos').mockReturnValue([
      repoRow({ id: 'repo', executionHostId: 'ssh:one' }),
      repoRow({ id: 'repo', executionHostId: 'ssh:two' })
    ])
    const { task, result } = await startWithMaxLoad(0.7)

    await expect(result).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        '--max-load cannot be applied: the worktree host could not be resolved unambiguously. Start the worker without --max-load.'
    })
    expect(loadavg).not.toHaveBeenCalled()
    expect(
      harness.db.db
        .prepare('SELECT COUNT(*) AS rows FROM dispatch_contexts WHERE task_id = ?')
        .get(task.id)
    ).toEqual({ rows: 0 })
  })

  it('samples the Run home load for a worktree no repo row carries', async () => {
    mockLegacyWorktree()
    vi.spyOn(harness.runtime, 'listRepos').mockReturnValue([])
    mockHostLoad(4, 8)
    const { result } = await startWithMaxLoad(0.7)

    await expect(result).resolves.toMatchObject({ state: 'ready' })
    expect(vi.mocked(os.loadavg)).toHaveBeenCalled()
  })

  it('samples the Run home load for a worktree on this host', async () => {
    mockHostLoad(4, 8)
    const { result } = await startWithMaxLoad(0.7)

    await expect(result).resolves.toMatchObject({ state: 'ready' })
    expect(vi.mocked(os.loadavg)).toHaveBeenCalled()
  })

  it('starts a worker in an SSH-backed worktree when --max-load is omitted', async () => {
    mockSshWorktree()

    await expect(harness.startWorker()).resolves.toMatchObject({ dispatchId: expect.any(String) })
  })

  it('rejects a non-positive ratio at the schema boundary', async () => {
    const { result } = await startWithMaxLoad(0)

    await expect(result).rejects.toThrow(/--max-load must be a positive ratio/)
  })

  it('surfaces the refusal as a typed OrchestrationError', async () => {
    mockHostLoad(9, 1)
    const { result } = await startWithMaxLoad(2)

    await expect(result).rejects.toBeInstanceOf(OrchestrationError)
  })
})
