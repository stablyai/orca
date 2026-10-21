import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExternalAutomationAction } from './external-manager'
import { mapOpenClawJobs } from './external-job-mappers'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import type {
  ExternalAutomationAction,
  ExternalAutomationProvider
} from '../../shared/automations-types'
import type * as Fs from 'node:fs'

const runProcessMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return {
    ...actual,
    existsSync: existsSyncMock
  }
})

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessMock.mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  existsSyncMock.mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runExternalAutomationAction', () => {
  it('runs local OpenClaw lifecycle actions through the CLI', async () => {
    await runExternalAutomationAction({
      managerId: 'openclaw:local',
      provider: 'openclaw',
      target: { type: 'local' },
      jobId: 'job-1',
      action: 'run'
    })

    expect(runProcessMock).toHaveBeenCalledWith({
      program: 'openclaw',
      args: ['cron', 'run', 'job-1'],
      timeoutMs: 30_000
    })
  })

  it('rejects job IDs that could be parsed as CLI options', async () => {
    await expect(
      runExternalAutomationAction({
        managerId: 'openclaw:local',
        provider: 'openclaw',
        target: { type: 'local' },
        jobId: '-help',
        action: 'run'
      })
    ).rejects.toThrow('Invalid external automation job ID.')

    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects an action name that is not in the provider table', async () => {
    await expect(
      runExternalAutomationAction({
        managerId: 'openclaw:local',
        provider: 'openclaw',
        target: { type: 'local' },
        jobId: 'job-1',
        action: 'purge' as ExternalAutomationAction
      })
    ).rejects.toThrow('Unsupported external automation action.')

    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects an action inherited from the prototype chain', async () => {
    await expect(
      runExternalAutomationAction({
        managerId: 'openclaw:local',
        provider: 'openclaw',
        target: { type: 'local' },
        jobId: 'job-1',
        action: 'toString' as unknown as ExternalAutomationAction
      })
    ).rejects.toThrow('Unsupported external automation action.')

    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects a provider that has no action table', async () => {
    await expect(
      runExternalAutomationAction({
        managerId: 'openclaw:local',
        provider: 'shellcat' as ExternalAutomationProvider,
        target: { type: 'local' },
        jobId: 'job-1',
        action: 'run'
      })
    ).rejects.toThrow('Unsupported external automation action.')

    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('maps OpenClaw lifecycle actions through its cron CLI names', async () => {
    await runExternalAutomationAction({
      managerId: 'openclaw:local',
      provider: 'openclaw',
      target: { type: 'local' },
      jobId: 'job-1',
      action: 'pause'
    })

    expect(runProcessMock).toHaveBeenCalledWith({
      program: 'openclaw',
      args: ['cron', 'disable', 'job-1'],
      timeoutMs: 30_000
    })
  })

  it('refuses actions on an SSH host without launching locally', async () => {
    await expect(
      runExternalAutomationAction({
        managerId: 'openclaw:ssh:ssh-1',
        provider: 'openclaw',
        target: { type: 'ssh', connectionId: 'ssh-1' },
        jobId: 'job-1',
        action: 'run'
      })
    ).rejects.toThrow(SSH_HOST_NOT_SERVED_MESSAGE)
    expect(runProcessMock).not.toHaveBeenCalled()
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
