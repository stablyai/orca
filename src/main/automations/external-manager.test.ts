/* eslint-disable max-lines -- Why: external automation mapping and lifecycle IPC share fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createExternalAutomation,
  listExternalAutomationManagers,
  listExternalAutomationRuns,
  runExternalAutomationAction,
  updateExternalAutomation
} from './external-manager'
import { mapHermesJobs, mapOpenClawJobs } from './external-job-mappers'
import { getActiveMultiplexer } from '../ipc/ssh'
import type { Store } from '../persistence'
import type * as Fs from 'node:fs'

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      const execCallback = callback as (error: Error | null, stdout: string, stderr: string) => void
      execCallback(null, '', '')
    }
    return { kill: vi.fn() }
  })
)
const existsSyncMock = vi.hoisted(() => vi.fn(() => false))

function resolveExecFileMock(...args: unknown[]) {
  const callback = args.at(-1)
  if (typeof callback === 'function') {
    const execCallback = callback as (error: Error | null, stdout: string, stderr: string) => void
    execCallback(null, '', '')
  }
  return { kill: vi.fn() }
}

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return {
    ...actual,
    existsSync: existsSyncMock
  }
})

vi.mock('../ipc/ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockImplementation(resolveExecFileMock)
  existsSyncMock.mockReturnValue(false)
  vi.mocked(getActiveMultiplexer).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listExternalAutomationManagers', () => {
  it('settles when a local command lookup hangs', async () => {
    vi.useFakeTimers()
    execFileMock.mockImplementation(() => ({ kill: vi.fn() }))
    const promise = listExternalAutomationManagers({
      getSshTargets: () => []
    } as unknown as Store)
    let settled = false
    void promise.finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()

    expect(settled).toBe(true)
    await expect(promise).resolves.toEqual([])
  })
})

describe('mapHermesJobs', () => {
  it('normalizes Hermes cron jobs into external automation rows', () => {
    const jobs = mapHermesJobs('hermes:local', [
      {
        id: 'job-1',
        name: 'Nightly audit',
        prompt: 'Audit the repo for risky dependency changes',
        schedule_display: '0 9 * * 1-5',
        enabled: true,
        state: 'scheduled',
        next_run_at: '2026-05-16T09:00:00Z',
        last_run_at: '2026-05-15T09:00:00Z',
        last_status: 'ok',
        workdir: '/repo'
      }
    ])

    expect(jobs).toEqual([
      {
        id: 'job-1',
        managerId: 'hermes:local',
        provider: 'hermes',
        name: 'Nightly audit',
        schedule: '0 9 * * 1-5',
        rawSchedule: '0 9 * * 1-5',
        enabled: true,
        state: 'scheduled',
        prompt: 'Audit the repo for risky dependency changes',
        promptPreview: 'Audit the repo for risky dependency changes',
        nextRunAt: '2026-05-16T09:00:00Z',
        lastRunAt: '2026-05-15T09:00:00Z',
        lastStatus: 'ok',
        lastError: null,
        workdir: '/repo',
        runCount: 0,
        runs: []
      }
    ])
  })

  it('normalizes Hermes output files into run history', () => {
    const jobs = mapHermesJobs('hermes:local', [
      {
        id: 'job-1',
        name: 'Nightly audit',
        schedule_display: '0 9 * * 1-5',
        runs: [
          {
            id: 'job-1:2026-05-15_09-00-00.md',
            job_id: 'job-1',
            run_at: '2026-05-15T09:00:00',
            status: 'completed',
            output_preview: 'No risky dependency changes.',
            output_path: '/home/me/.hermes/cron/output/job-1/2026-05-15_09-00-00.md'
          },
          {
            id: 'job-1:2026-05-14_09-00-00.md',
            job_id: 'job-1',
            run_at: '2026-05-14T09:00:00',
            status: 'failed',
            error: 'RuntimeError: missing key'
          }
        ]
      }
    ])

    expect(jobs[0].runs).toEqual([
      {
        id: 'job-1:2026-05-15_09-00-00.md',
        managerId: 'hermes:local',
        provider: 'hermes',
        jobId: 'job-1',
        runAt: '2026-05-15T09:00:00',
        status: 'completed',
        outputPreview: 'No risky dependency changes.',
        outputContent: null,
        error: null,
        outputPath: '/home/me/.hermes/cron/output/job-1/2026-05-15_09-00-00.md'
      },
      {
        id: 'job-1:2026-05-14_09-00-00.md',
        managerId: 'hermes:local',
        provider: 'hermes',
        jobId: 'job-1',
        runAt: '2026-05-14T09:00:00',
        status: 'failed',
        outputPreview: null,
        outputContent: null,
        error: 'RuntimeError: missing key',
        outputPath: null
      }
    ])
  })

  it('falls back to script and schedule fields for older Hermes records', () => {
    const jobs = mapHermesJobs('hermes:local', [
      {
        id: 'job-2',
        script: 'disk-check.sh',
        no_agent: true,
        schedule: { display: 'every 30m' },
        enabled: false,
        state: 'paused',
        last_delivery_error: 'home channel missing'
      }
    ])

    expect(jobs[0]).toMatchObject({
      id: 'job-2',
      name: 'Script: disk-check.sh',
      schedule: 'every 30m',
      enabled: false,
      state: 'paused',
      promptPreview: 'Script: disk-check.sh',
      prompt: null,
      rawSchedule: 'every 30m',
      lastError: 'home channel missing'
    })
  })
})

describe('createExternalAutomation', () => {
  it('creates local Hermes cron jobs through the CLI', async () => {
    await createExternalAutomation({
      managerId: 'hermes:local',
      provider: 'hermes',
      target: { type: 'local' },
      name: 'Nightly audit',
      prompt: 'Audit the repo',
      schedule: '0 9 * * 1-5',
      workdir: '/repo'
    })

    expect(execFileMock).toHaveBeenCalledWith(
      'hermes',
      [
        'cron',
        'create',
        '0 9 * * 1-5',
        'Audit the repo',
        '--name',
        'Nightly audit',
        '--deliver',
        'local',
        '--workdir',
        '/repo'
      ],
      { encoding: 'utf-8', timeout: 30_000 },
      expect.any(Function)
    )
  })

  it('settles when local Hermes cron creation hangs', async () => {
    vi.useFakeTimers()
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))

    const promise = createExternalAutomation({
      managerId: 'hermes:local',
      provider: 'hermes',
      target: { type: 'local' },
      name: 'Nightly audit',
      prompt: 'Audit the repo',
      schedule: '0 9 * * 1-5',
      workdir: null
    })
    let settled = false
    void promise
      .catch(() => undefined)
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.resolve()

    expect(settled).toBe(true)
    await expect(promise).rejects.toThrow('Local automation command timed out')
    expect(killMock).toHaveBeenCalled()
  })

  it('updates local Hermes cron jobs through the CLI', async () => {
    await updateExternalAutomation({
      managerId: 'hermes:local',
      provider: 'hermes',
      target: { type: 'local' },
      jobId: 'job-1',
      name: 'Nightly audit',
      prompt: 'Audit the repo',
      schedule: '0 10 * * 1-5',
      workdir: '/repo'
    })

    expect(execFileMock).toHaveBeenCalledWith(
      'hermes',
      [
        'cron',
        'edit',
        'job-1',
        '--schedule',
        '0 10 * * 1-5',
        '--prompt',
        'Audit the repo',
        '--name',
        'Nightly audit',
        '--workdir',
        '/repo'
      ],
      { encoding: 'utf-8', timeout: 30_000 },
      expect.any(Function)
    )
  })
})

describe('runExternalAutomationAction', () => {
  it('runs local Hermes lifecycle actions through the CLI', async () => {
    await runExternalAutomationAction({
      managerId: 'hermes:local',
      provider: 'hermes',
      target: { type: 'local' },
      jobId: 'job-1',
      action: 'run'
    })

    expect(execFileMock).toHaveBeenCalledWith(
      'hermes',
      ['cron', 'run', 'job-1'],
      { encoding: 'utf-8', timeout: 30_000 },
      expect.any(Function)
    )
  })

  it('rejects job IDs that could be parsed as CLI options', async () => {
    await expect(
      runExternalAutomationAction({
        managerId: 'hermes:local',
        provider: 'hermes',
        target: { type: 'local' },
        jobId: '-help',
        action: 'run'
      })
    ).rejects.toThrow('Invalid external automation job ID.')

    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('maps OpenClaw lifecycle actions through its cron CLI names', async () => {
    await runExternalAutomationAction({
      managerId: 'openclaw:local',
      provider: 'openclaw',
      target: { type: 'local' },
      jobId: 'job-1',
      action: 'pause'
    })

    expect(execFileMock).toHaveBeenCalledWith(
      'openclaw',
      ['cron', 'disable', 'job-1'],
      { encoding: 'utf-8', timeout: 30_000 },
      expect.any(Function)
    )
  })
})

describe('listExternalAutomationRuns', () => {
  it('requests paginated Hermes runs from the remote relay', async () => {
    const request = vi.fn().mockResolvedValue({
      total: 42,
      runs: [
        {
          id: 'job-1:2026-05-15_09-00-00.md',
          job_id: 'job-1',
          run_at: '2026-05-15T09:00:00',
          status: 'completed',
          output_preview: 'No risky dependency changes.'
        }
      ]
    })
    vi.mocked(getActiveMultiplexer).mockReturnValue({
      isDisposed: () => false,
      request
    } as unknown as ReturnType<typeof getActiveMultiplexer>)

    await expect(
      listExternalAutomationRuns({
        managerId: 'hermes:ssh:ssh-1',
        provider: 'hermes',
        target: { type: 'ssh', connectionId: 'ssh-1' },
        jobId: 'job-1',
        page: 2,
        pageSize: 10
      })
    ).resolves.toMatchObject({
      managerId: 'hermes:ssh:ssh-1',
      provider: 'hermes',
      jobId: 'job-1',
      page: 2,
      pageSize: 10,
      total: 42,
      runs: [
        {
          id: 'job-1:2026-05-15_09-00-00.md',
          managerId: 'hermes:ssh:ssh-1',
          provider: 'hermes',
          jobId: 'job-1',
          runAt: '2026-05-15T09:00:00',
          status: 'completed',
          outputPreview: 'No risky dependency changes.'
        }
      ]
    })

    expect(request).toHaveBeenCalledWith('externalAutomations.runs', {
      provider: 'hermes',
      jobId: 'job-1',
      page: 2,
      pageSize: 10
    })
  })
})

describe('mapOpenClawJobs', () => {
  it('normalizes OpenClaw cron jobs into external automation rows', () => {
    const jobs = mapOpenClawJobs('openclaw:local', {
      version: 1,
      jobs: [
        {
          id: 'claw-1',
          name: 'Morning report',
          enabled: true,
          schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/Phoenix' },
          payload: { kind: 'agentTurn', message: 'Summarize overnight alerts' },
          state: {
            nextRunAtMs: Date.parse('2026-05-16T16:00:00Z'),
            lastRunAtMs: Date.parse('2026-05-15T16:00:00Z'),
            lastRunStatus: 'ok'
          }
        }
      ]
    })

    expect(jobs[0]).toMatchObject({
      id: 'claw-1',
      managerId: 'openclaw:local',
      provider: 'openclaw',
      name: 'Morning report',
      schedule: 'cron 0 9 * * * @ America/Phoenix',
      rawSchedule: '0 9 * * *',
      enabled: true,
      state: 'ok',
      prompt: 'Summarize overnight alerts',
      promptPreview: 'Summarize overnight alerts',
      nextRunAt: '2026-05-16T16:00:00.000Z',
      lastRunAt: '2026-05-15T16:00:00.000Z',
      lastStatus: 'ok'
    })
  })
})
