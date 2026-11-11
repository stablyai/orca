import { describe, expect, it, vi } from 'vitest'
import { reconcileManagedWslCliRegistrations } from './wsl-cli-registration-reconciliation'
import { runSerializedWslCliRegistrationOperation } from './wsl-cli-registration-operation'

describe('reconcileManagedWslCliRegistrations', () => {
  it('lets a Settings removal win over a late startup repair for the same distro', async () => {
    const events: string[] = []
    let repairStarted!: () => void
    let finishRepair!: () => void
    const started = new Promise<void>((resolve) => {
      repairStarted = resolve
    })
    const registry = {
      getCandidates: vi.fn(async () => ['Ubuntu']),
      recordObservations: vi.fn(async () => {
        events.push('repair-observed')
      })
    }
    const reconciliation = reconcileManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      userDataPath: '/user-data',
      listDistros: async () => ['Ubuntu'],
      listRunningDistros: async () => ['Ubuntu'],
      isDistroRunning: async (distro: string) => ['Ubuntu'].includes(distro),
      registry,
      createInstaller: () => ({
        repairManagedRegistration: async () => {
          events.push('repair-started')
          repairStarted()
          await new Promise<void>((resolve) => {
            finishRepair = resolve
          })
          events.push('repair-finished')
          return {
            changed: true,
            managed: true,
            status: { state: 'installed' as const }
          }
        }
      })
    })
    await started

    const removal = runSerializedWslCliRegistrationOperation('ubuntu', async () => {
      events.push('settings-remove')
    })
    await Promise.resolve()
    expect(events).toEqual(['repair-started'])

    finishRepair()
    await Promise.all([reconciliation, removal])
    expect(events).toEqual([
      'repair-started',
      'repair-finished',
      'repair-observed',
      'settings-remove'
    ])
  })
})
