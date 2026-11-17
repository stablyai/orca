import { afterEach, describe, expect, it } from 'vitest'
import { translateWslOutputPath } from '../../git/command-runner/host-routing/wsl-path-translation'
import { resetWslAutomountRootsForTests, settleWslAutomountRoot } from './wsl-automount-root'

afterEach(() => resetWslAutomountRootsForTests())

describe('settleWslAutomountRoot', () => {
  it('maps Git output under a custom root back to the drive once settled', async () => {
    await settleWslAutomountRoot('Ubuntu', { read: async () => '/qamnt/' })

    expect(translateWslOutputPath('/qamnt/c/wt/child', 'C:\\wt', { wslDistro: 'Ubuntu' })).toBe(
      'C:\\wt\\child'
    )
  })

  it('refuses when the root cannot be read, instead of guessing /mnt/', async () => {
    await expect(settleWslAutomountRoot('Ubuntu', { read: async () => null })).rejects.toThrow()
  })
})
