import { describe, expect, it, vi } from 'vitest'
import { listRunningDistrosForSnapshot } from './wsl-usage-reporter'
import { buildWslUsageSnapshot } from './wsl-usage-snapshot'
import { wslUsageSnapshotSchema } from '../../shared/telemetry/schemas/telemetry-wsl-usage-event-schemas'

describe('listRunningDistrosForSnapshot', () => {
  it('probes no running list when no Orca project uses WSL, and says it did not', async () => {
    const probe = vi.fn(async () => ['Ubuntu'])
    await expect(
      listRunningDistrosForSnapshot([{ distro: 'Ubuntu' }], false, () => null, probe)
    ).resolves.toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('buildWslUsageSnapshot running count', () => {
  const input = {
    registeredDistroCount: 1,
    userDistros: [{ version: 2 as const, state: 'stopped' as const }],
    wslPackageVersion: null,
    wslAvailableCached: null,
    projects: [],
    windowsDriveReposWithWslWorktrees: 0,
    wslHostsGateOpen: false
  }

  it('omits distros_running when running state was not probed, rather than reporting 0', () => {
    const props = buildWslUsageSnapshot({ ...input, distrosRunningKnown: false })
    expect(props).not.toHaveProperty('distros_running')
    expect(wslUsageSnapshotSchema.safeParse(props).success).toBe(true)
  })
})
