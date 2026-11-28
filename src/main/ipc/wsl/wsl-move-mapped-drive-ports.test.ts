import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'

vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-registry', () => ({
  readWslHostDeployments: async () => ({ deployments: [], unreadableEnvironmentIds: new Set() })
}))

const originalPlatform = process.platform
const originalSystemDrive = process.env.SystemDrive

function storeWith(...paths: string[]) {
  const repos: Repo[] = paths.map((path, index) => ({
    id: `r${index}`,
    path,
    displayName: 'p',
    badgeColor: '',
    addedAt: 0
  }))
  return { getRepos: () => repos, getFolderWorkspaces: () => [] }
}

// The real in-use check over the real last-known reader, fresh per test (SystemDrive is read once).
async function inUse(store: ReturnType<typeof storeWith>, distro = 'Debian'): Promise<boolean> {
  const { isDistroInUse } =
    await import('../../persistence/moving-wsl-projects/quiescence/wsl-move-distro-in-use')
  const { wslMoveDistroMappedDrivesLastKnown } = await import('./wsl-move-mapped-drive-ports')
  return isDistroInUse(store, '/unused', distro, () =>
    wslMoveDistroMappedDrivesLastKnown(store, distro)
  )
}

async function lastKnown() {
  return import('../../wsl/filesystem/wsl-mapped-drive-last-known')
}

describe('isDistroInUse over last-known mapped drives', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.SystemDrive = 'C:'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    if (originalSystemDrive === undefined) {
      delete process.env.SystemDrive
    } else {
      process.env.SystemDrive = originalSystemDrive
    }
  })

  it('reads a system-drive project with no saved answer as not in use, so no hold', async () => {
    expect(await inUse(storeWith('C:\\src\\app'))).toBe(false)
  })

  it('keeps a system-drive project unverifiable when SystemDrive is unset', async () => {
    delete process.env.SystemDrive
    expect(await inUse(storeWith('C:\\src\\app'))).toBe(true)
  })

  it('keeps a mapped W: with no answer unverifiable, so the hold stays', async () => {
    expect(await inUse(storeWith('C:\\src\\app', 'W:\\proj'))).toBe(true)
  })

  it('keeps a W: whose only answer is a saved null unverifiable: it may be a failed lookup', async () => {
    ;(await lastKnown()).seedWslMappedDriveAnswers([{ letter: 'W', share: null, at: 1 }])
    expect(await inUse(storeWith('W:\\proj'))).toBe(true)
  })

  it('trusts a W: this launch read outside WSL', async () => {
    ;(await lastKnown()).rememberWslMappedDriveRead('W', 'W:\\', 1)
    expect(await inUse(storeWith('W:\\proj'))).toBe(false)
  })

  it('still sees a project on a W: known to map into the distro', async () => {
    ;(await lastKnown()).seedWslMappedDriveAnswers([
      { letter: 'W', share: '\\\\wsl.localhost\\Debian', at: 1 }
    ])
    expect(await inUse(storeWith('W:\\proj'))).toBe(true)
  })
})
