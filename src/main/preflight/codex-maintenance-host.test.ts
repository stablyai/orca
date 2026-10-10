import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import type { CodexMaintenanceState } from '../../shared/codex-cli-maintenance'
import { codexMaintenanceOnHost } from './codex-maintenance-host'

const { start, status } = vi.hoisted(() => ({ start: vi.fn(), status: vi.fn() }))
vi.mock('./codex-maintenance-runner', () => ({ codexMaintenanceRunner: { start, status } }))
afterEach(() => vi.clearAllMocks())

const STATE: CodexMaintenanceState = {
  installation: codexCliInstallation(false, null),
  canRun: true,
  job: null
}

describe('Codex maintenance on the execution host', () => {
  it('routes status, job reads and an explicit start to the host runner with host settings', async () => {
    start.mockResolvedValue(STATE)
    status.mockResolvedValue(STATE)
    const settings = { agentCmdOverrides: { codex: '/host/codex' } }
    await codexMaintenanceOnHost({ operation: 'status', cwd: '/workspace' }, settings)
    await codexMaintenanceOnHost({ operation: 'read', jobId: 'job' }, settings)
    await codexMaintenanceOnHost({ operation: 'start' }, settings)
    expect(status.mock.calls).toEqual([
      [undefined, { cwd: '/workspace', commandSettings: settings }],
      ['job', { cwd: undefined, commandSettings: settings }]
    ])
    expect(start).toHaveBeenCalledExactlyOnceWith({ cwd: undefined, commandSettings: settings })
  })
})
