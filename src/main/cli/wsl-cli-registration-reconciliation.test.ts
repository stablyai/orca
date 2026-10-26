import { describe, expect, it, vi } from 'vitest'
import { reconcileManagedWslCliRegistrations } from './wsl-cli-registration-reconciliation'
import { runSerializedWslCliRegistrationOperation } from './wsl-cli-registration-operation'

describe('reconcileManagedWslCliRegistrations', () => {
  it('repairs known and newly discovered registrations, then records ownership', async () => {
    const registry = {
      getCandidates: vi.fn(async () => ['Ubuntu', 'Debian']),
      recordObservations: vi.fn(async () => undefined)
    }
    const repairUbuntu = vi.fn(async () => ({
      changed: true,
      managed: true,
      status: { state: 'installed' as const }
    }))
    const repairDebian = vi.fn(async () => ({
      changed: false,
      managed: false,
      status: { state: 'not_installed' as const }
    }))

    const results = await reconcileManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      userDataPath: '/user-data',
      listDistros: async () => ['Ubuntu', 'Debian', 'Fedora'],
      listRunningDistros: async () => ['Ubuntu', 'Debian', 'Fedora'],
      registry,
      createInstaller: (distro) => {
        if (distro === 'Ubuntu') {
          return { repairManagedRegistration: repairUbuntu }
        }
        return { repairManagedRegistration: repairDebian }
      }
    })

    expect(registry.getCandidates).toHaveBeenCalledWith(['Ubuntu', 'Debian', 'Fedora'], {
      currentTarget: null,
      appVersion: ''
    })
    expect(registry.recordObservations).toHaveBeenCalledTimes(2)
    expect(registry.recordObservations).toHaveBeenCalledWith([
      { distro: 'Ubuntu', inspected: true, managed: true }
    ])
    expect(registry.recordObservations).toHaveBeenCalledWith([
      { distro: 'Debian', inspected: true, managed: false, reconciled: null }
    ])
    expect(results).toEqual([
      { distro: 'Ubuntu', outcome: 'repaired', state: 'installed', managed: true },
      { distro: 'Debian', outcome: 'unchanged', state: 'not_installed', managed: false }
    ])
  })

  it('passes the host launcher target through and records reconciliations against it', async () => {
    const registry = {
      getCandidates: vi.fn(async () => ['Ubuntu']),
      recordObservations: vi.fn(async () => undefined)
    }

    await reconcileManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      userDataPath: '/user-data',
      appVersion: '1.4.138',
      listDistros: async () => ['Ubuntu'],
      listRunningDistros: async () => ['Ubuntu'],
      getHostLauncherTarget: async () => 'C:\\Orca\\resources\\bin\\orca.exe',
      registry,
      createInstaller: () => ({
        repairManagedRegistration: async () => ({
          changed: true,
          managed: true,
          status: { state: 'installed' as const }
        })
      })
    })

    expect(registry.getCandidates).toHaveBeenCalledWith(['Ubuntu'], {
      currentTarget: 'C:\\Orca\\resources\\bin\\orca.exe',
      appVersion: '1.4.138'
    })
    expect(registry.recordObservations).toHaveBeenCalledWith([
      {
        distro: 'Ubuntu',
        inspected: true,
        managed: true,
        reconciled: { target: 'C:\\Orca\\resources\\bin\\orca.exe', appVersion: '1.4.138' }
      }
    ])
  })

  it('records unsupported distros without changing ownership and skips failed ones', async () => {
    const registry = {
      getCandidates: vi.fn(async () => ['Broken Distro', 'No Interop']),
      recordObservations: vi.fn(async () => undefined)
    }

    const results = await reconcileManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      userDataPath: '/user-data',
      listDistros: async () => ['Broken Distro', 'No Interop'],
      listRunningDistros: async () => ['Broken Distro', 'No Interop'],
      registry,
      createInstaller: (distro) => ({
        repairManagedRegistration: async () => {
          if (distro === 'Broken Distro') {
            throw new Error('WSL interop failed')
          }
          return {
            changed: false,
            managed: false,
            status: { state: 'unsupported' as const }
          }
        }
      })
    })

    expect(results).toEqual([
      { distro: 'Broken Distro', outcome: 'failed', error: 'WSL interop failed' },
      { distro: 'No Interop', outcome: 'unchanged', state: 'unsupported', managed: false }
    ])
    expect(registry.recordObservations).toHaveBeenCalledTimes(1)
    // Cache unsupported inspections without changing ownership or repeating startup probes.
    expect(registry.recordObservations).toHaveBeenCalledWith([
      { distro: 'No Interop', inspected: true, managed: null, reconciled: null }
    ])
  })

  it('keeps a successful repair result when observation recording fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const results = await reconcileManagedWslCliRegistrations({
        platform: 'win32',
        isPackaged: true,
        userDataPath: '/user-data',
        listDistros: async () => ['Ubuntu'],
        listRunningDistros: async () => ['Ubuntu'],
        registry: {
          getCandidates: async () => ['Ubuntu'],
          recordObservations: async () => {
            throw new Error('ENOSPC')
          }
        },
        createInstaller: () => ({
          repairManagedRegistration: async () => ({
            changed: true,
            managed: true,
            status: { state: 'installed' as const }
          })
        })
      })

      expect(results).toEqual([
        { distro: 'Ubuntu', outcome: 'repaired', state: 'installed', managed: true }
      ])
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    { platform: 'darwin' as const, isPackaged: true },
    { platform: 'linux' as const, isPackaged: true },
    { platform: 'win32' as const, isPackaged: false }
  ])('does not inspect local, SSH, or development hosts for $platform', async (host) => {
    const listDistros = vi.fn(async () => ['Ubuntu'])

    await expect(
      reconcileManagedWslCliRegistrations({
        ...host,
        userDataPath: '/user-data',
        listDistros
      })
    ).resolves.toEqual([])
    expect(listDistros).not.toHaveBeenCalled()
  })

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

  it('defers stopped candidates without booting them and reconciles each once it runs', async () => {
    const registry = {
      getCandidates: vi.fn(async (available: string[]) =>
        ['Ubuntu', 'Debian'].filter((distro) => available.includes(distro))
      ),
      recordObservations: vi.fn(async () => undefined)
    }
    const repaired: string[] = []
    const deferred = new Map<string, () => unknown>()
    let running = ['Ubuntu']
    const options = {
      platform: 'win32' as const,
      isPackaged: true,
      userDataPath: '/user-data',
      listDistros: async () => ['Ubuntu', 'Debian'],
      listRunningDistros: async () => running,
      deferUntilRunning: (distro: string, _key: string, task: () => unknown) => {
        deferred.set(distro, task)
      },
      registry,
      createInstaller: (distro: string) => ({
        repairManagedRegistration: async () => {
          repaired.push(distro)
          return { changed: false, managed: true, status: { state: 'installed' as const } }
        }
      })
    }

    await expect(reconcileManagedWslCliRegistrations(options)).resolves.toEqual([
      { distro: 'Ubuntu', outcome: 'unchanged', state: 'installed', managed: true },
      { distro: 'Debian', outcome: 'deferred' }
    ])
    expect(repaired).toEqual(['Ubuntu'])
    expect([...deferred.keys()]).toEqual(['Debian'])

    running = ['Ubuntu', 'Debian']
    await deferred.get('Debian')?.()
    expect(repaired).toEqual(['Ubuntu', 'Debian'])
    expect(registry.getCandidates).toHaveBeenLastCalledWith(['Debian'], {
      currentTarget: null,
      appVersion: ''
    })
  })

  it('defers every candidate when no distro is running', async () => {
    const repair = vi.fn()
    const deferUntilRunning = vi.fn()
    const results = await reconcileManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      userDataPath: '/user-data',
      listDistros: async () => ['Ubuntu'],
      listRunningDistros: async () => [],
      deferUntilRunning,
      registry: { getCandidates: async () => ['Ubuntu'], recordObservations: vi.fn() },
      createInstaller: () => ({ repairManagedRegistration: repair })
    })

    expect(results).toEqual([{ distro: 'Ubuntu', outcome: 'deferred' }])
    expect(repair).not.toHaveBeenCalled()
    expect(deferUntilRunning).toHaveBeenCalledWith(
      'Ubuntu',
      expect.any(String),
      expect.any(Function)
    )
  })
})
