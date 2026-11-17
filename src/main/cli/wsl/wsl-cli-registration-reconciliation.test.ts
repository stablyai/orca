import { describe, expect, it, vi } from 'vitest'
import { reconcileManagedWslCliRegistrations } from './wsl-cli-registration-reconciliation'

// Review repro for #43496: a WSL host distro must stay inspectable at startup without any
// local project naming it, since nothing re-runs discovery when such a project appears later.
describe('reconcileManagedWslCliRegistrations', () => {
  function rig(running: string[]) {
    const repair = vi.fn(async () => ({
      changed: true,
      managed: true,
      status: { state: 'installed' as const }
    }))
    const deferred: string[] = []
    const options = {
      platform: 'win32' as const,
      isPackaged: true,
      userDataPath: '/unused',
      listDistros: async () => ['Ubuntu', 'Debian'],
      createInstaller: () => ({ repairManagedRegistration: repair }),
      getHostLauncherTarget: async () => 'C:\\Orca\\orca.cmd',
      registry: {
        getCandidates: async (
          available: string[],
          context?: { inspectableDistros?: readonly string[] }
        ) => available.filter((distro) => context?.inspectableDistros?.includes(distro)),
        recordObservations: async () => {}
      },
      listOrcaHostDistros: () => ['Ubuntu'],
      listRunningDistros: async () => running,
      isDistroRunning: async (distro: string) => running.includes(distro),
      deferUntilRunning: (distro: string) => {
        deferred.push(distro)
      }
    }
    return { options, repair, deferred }
  }

  it('inspects a running WSL host distro that no local project uses', async () => {
    const { options, repair } = rig(['Ubuntu'])
    const results = await reconcileManagedWslCliRegistrations(options)
    expect(results).toEqual([
      { distro: 'Ubuntu', outcome: 'repaired', state: 'installed', managed: true }
    ])
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('defers a stopped WSL host distro instead of starting it', async () => {
    const { options, repair, deferred } = rig([])
    const results = await reconcileManagedWslCliRegistrations(options)
    expect(results).toEqual([{ distro: 'Ubuntu', outcome: 'deferred' }])
    expect(deferred).toEqual(['Ubuntu'])
    expect(repair).not.toHaveBeenCalled()
  })
})
