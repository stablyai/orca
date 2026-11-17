import { describe, expect, it, vi } from 'vitest'
import { reconcileManagedWslCliRegistrations } from './wsl-cli-registration-reconciliation'
import type { LegacyWslDemand } from '../../wsl/discovery/legacy-wsl-demand'

function rig(args: { recorded: string[]; hostDistros: string[]; demand: LegacyWslDemand | null }) {
  const listDistros = vi.fn(async () => ['Ubuntu', 'Debian'])
  const listRunningDistros = vi.fn(async () => ['Ubuntu', 'Debian'])
  const repair = vi.fn(async () => ({
    changed: false,
    managed: true,
    status: { state: 'installed' as const }
  }))
  const options = {
    platform: 'win32' as const,
    isPackaged: true,
    userDataPath: '/unused',
    createInstaller: () => ({ repairManagedRegistration: repair }),
    getHostLauncherTarget: async () => 'C:\\Orca\\orca.cmd',
    registry: {
      getCandidates: (available: string[], context?: { inspectableDistros?: readonly string[] }) =>
        // Registered distros pass; host distros pass only when inspectable.
        Promise.resolve(
          available.filter(
            (distro) =>
              args.recorded.includes(distro) || context?.inspectableDistros?.includes(distro)
          )
        ),
      recordObservations: async () => {},
      listRecorded: async () => args.recorded
    },
    listOrcaHostDistros: () => args.hostDistros,
    listRunningDistros,
    isDistroRunning: async () => true,
    deferUntilRunning: () => {},
    readLegacyDemand: () => args.demand
  }
  return { options, listDistros, listRunningDistros, repair }
}

describe('reconcileManagedWslCliRegistrations scoping', () => {
  it('runs no wsl.exe for a WSL-host-only user', async () => {
    const { options, listRunningDistros, repair } = rig({
      recorded: [],
      hostDistros: ['Ubuntu'],
      demand: { distros: [], defaultDistro: false }
    })
    const getCandidates = vi.fn(options.registry.getCandidates)
    await expect(
      reconcileManagedWslCliRegistrations({
        ...options,
        registry: { ...options.registry, getCandidates }
      })
    ).resolves.toEqual([])
    // Returned before the distro list, which is the first `wsl.exe` call.
    expect(getCandidates).not.toHaveBeenCalled()
    expect(listRunningDistros).not.toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
  })

  it('skips a WSL host distro with no legacy project but still repairs a user-installed CLI', async () => {
    const { options, listDistros, repair } = rig({
      recorded: ['Debian'],
      hostDistros: ['Ubuntu'],
      demand: { distros: [], defaultDistro: false }
    })
    const results = await reconcileManagedWslCliRegistrations({ ...options, listDistros })
    expect(results.map((result) => result.distro)).toEqual(['Debian'])
    expect(repair).toHaveBeenCalledTimes(1)
  })
})
