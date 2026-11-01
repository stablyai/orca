import { describe, expect, it } from 'vitest'
import type { WslDistroRegistration } from './wsl-distro-registry-id'
import { admitWslHostDistro } from './wsl-host-add-admission'
import { listWslHostDistros } from './wsl-host-distro-list'

const registrations: WslDistroRegistration[] = [
  { id: 'a', distro: 'Ubuntu', version: 2 },
  { id: 'b', distro: 'Debian', version: 2 },
  { id: 'c', distro: 'docker-desktop', version: 2 }
]
const readRegistrations = async () => registrations

describe('listWslHostDistros', () => {
  it('marks each user distro running or stopped from a confirmed read', async () => {
    const distros = await listWslHostDistros({
      readRegistrations,
      readRunning: async () => ({ status: 'confirmed', distros: ['ubuntu'] })
    })
    expect(distros.map(({ name, state }) => [name, state])).toEqual([
      ['Debian', 'stopped'],
      ['Ubuntu', 'running']
    ])
  })

  it('says unverifiable, never stopped, when the running list cannot be read', async () => {
    for (const readRunning of [
      async () => ({ status: 'unavailable' }) as const,
      async () => {
        throw new Error('wsl.exe timed out')
      }
    ]) {
      const distros = await listWslHostDistros({ readRegistrations, readRunning })
      expect(distros.map(({ state }) => state)).toEqual(['unverifiable', 'unverifiable'])
    }
  })
})

describe('admitWslHostDistro', () => {
  const candidate = { id: 'a', name: 'Ubuntu', version: 2 as const, state: 'unverifiable' as const }

  it('needs the user’s explicit start for a distro WSL could not vouch for', () => {
    const refused = admitWslHostDistro({
      requested: 'Ubuntu',
      candidates: [candidate],
      alreadyAdded: () => false,
      startIfStopped: false
    })
    expect(refused).toMatchObject({ ok: false, kind: 'failed', errorCode: 'distroUnverifiable' })
    expect(
      admitWslHostDistro({
        requested: 'Ubuntu',
        candidates: [candidate],
        alreadyAdded: () => false,
        startIfStopped: true
      })
    ).toEqual({ distro: candidate })
  })
})
