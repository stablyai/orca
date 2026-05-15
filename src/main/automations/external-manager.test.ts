import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runExternalAutomationAction } from './external-manager'
import { mapHermesJobs, mapOpenClawJobs } from './external-job-mappers'

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      const execCallback = callback as (error: Error | null, stdout: string, stderr: string) => void
      execCallback(null, '', '')
    }
  })
)

vi.mock('child_process', () => ({ execFile: execFileMock }))

vi.mock('../ipc/ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

beforeEach(() => {
  execFileMock.mockClear()
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
        enabled: true,
        state: 'scheduled',
        promptPreview: 'Audit the repo for risky dependency changes',
        nextRunAt: '2026-05-16T09:00:00Z',
        lastRunAt: '2026-05-15T09:00:00Z',
        lastStatus: 'ok',
        lastError: null,
        workdir: '/repo'
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
      lastError: 'home channel missing'
    })
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
      { encoding: 'utf-8' },
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
      { encoding: 'utf-8' },
      expect.any(Function)
    )
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
      enabled: true,
      state: 'ok',
      promptPreview: 'Summarize overnight alerts',
      nextRunAt: '2026-05-16T16:00:00.000Z',
      lastRunAt: '2026-05-15T16:00:00.000Z',
      lastStatus: 'ok'
    })
  })
})
