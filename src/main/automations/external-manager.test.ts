import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExternalAutomationAction } from './external-manager'

import type {
  ExternalAutomationAction,
  ExternalAutomationProvider
} from '../../shared/automations/external/external-automation'
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
})
