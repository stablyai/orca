import '../../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { describe, expect, it, vi } from 'vitest'
import { listWslHostDistros } from './wsl-host-distro-list'

describe('listWslHostDistros', () => {
  it('never reads the running list when the registry cannot be read (no WSL installed)', async () => {
    const readRunning = vi.fn()
    await expect(
      listWslHostDistros({ readRegistrations: async () => null, readRunning })
    ).resolves.toEqual([])
    expect(readRunning).not.toHaveBeenCalled()
  })

  it('never reads the running list when only internal distros are registered', async () => {
    const readRunning = vi.fn()
    await expect(
      listWslHostDistros({
        readRegistrations: async () => [{ id: 'a', distro: 'docker-desktop', version: 2 }],
        readRunning
      })
    ).resolves.toEqual([])
    expect(readRunning).not.toHaveBeenCalled()
  })

  it('marks user distros running, stopped, or unverifiable from the running list', async () => {
    const readRegistrations = async () => [
      { id: 'b', distro: 'Ubuntu', version: 2 as const },
      { id: 'a', distro: 'Debian', version: 1 as const },
      { id: 'c', distro: 'docker-desktop', version: 2 as const }
    ]
    await expect(
      listWslHostDistros({
        readRegistrations,
        readRunning: async () => ({ status: 'confirmed', distros: ['ubuntu'] })
      })
    ).resolves.toEqual([
      { id: 'a', name: 'Debian', version: 1, state: 'stopped' },
      { id: 'b', name: 'Ubuntu', version: 2, state: 'running' }
    ])
    await expect(
      listWslHostDistros({
        readRegistrations,
        readRunning: async () => {
          throw new Error('wsl.exe failed')
        }
      })
    ).resolves.toEqual([
      { id: 'a', name: 'Debian', version: 1, state: 'unverifiable' },
      { id: 'b', name: 'Ubuntu', version: 2, state: 'unverifiable' }
    ])
  })
})
