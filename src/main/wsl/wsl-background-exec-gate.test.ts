import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWslDistrosAsync: async () => ['Ubuntu']
}))

import { runAsWslLaunchUserAct } from './wsl-background-exec-gate'
import { isWslUserActFor } from './wsl-user-act-scope'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

async function actsOnUbuntu(launch: Parameters<typeof runAsWslLaunchUserAct>[0]): Promise<boolean> {
  return runAsWslLaunchUserAct(launch, async () => isWslUserActFor('Ubuntu'))
}

// The default distro stands in for a null one only for a WSL launch someone asked for (E9).
describe('runAsWslLaunchUserAct', () => {
  it('acts on the named or default distro for a WSL launch someone asked for', async () => {
    await expect(
      actsOnUbuntu({ isWsl: true, passiveRestore: false, distro: 'Ubuntu' })
    ).resolves.toBe(true)
    await expect(actsOnUbuntu({ isWsl: true, passiveRestore: false, distro: null })).resolves.toBe(
      true
    )
  })

  it('never acts for a passive restore or a non-WSL launch, even with a default distro', async () => {
    await expect(actsOnUbuntu({ isWsl: true, passiveRestore: true, distro: null })).resolves.toBe(
      false
    )
    await expect(
      actsOnUbuntu({ isWsl: true, passiveRestore: true, distro: 'Ubuntu' })
    ).resolves.toBe(false)
    await expect(actsOnUbuntu({ isWsl: false, passiveRestore: false, distro: null })).resolves.toBe(
      false
    )
  })
})
