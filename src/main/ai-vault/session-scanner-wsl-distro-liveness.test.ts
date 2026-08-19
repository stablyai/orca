import { afterEach, describe, expect, it } from 'vitest'
import { _resetRunningWslDistrosCacheForTests, _setRunningWslDistrosForTests } from '../wsl'
import { stoppedWslDistroForRoot } from './session-scanner-wsl-distro-liveness'

describe('stoppedWslDistroForRoot', () => {
  afterEach(() => {
    _resetRunningWslDistrosCacheForTests()
  })

  it('returns null for a local (non-UNC) path without probing anything', async () => {
    await expect(stoppedWslDistroForRoot('C:\\Users\\ada\\.claude\\projects')).resolves.toBeNull()
  })

  it('returns null when the running-distros probe is unknown (fail open)', async () => {
    // No seed: listRunningWslDistrosAsync fails open (null) under NODE_ENV=test.
    await expect(
      stoppedWslDistroForRoot('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions')
    ).resolves.toBeNull()
  })

  it('returns null when the distro is running', async () => {
    _setRunningWslDistrosForTests(['Ubuntu', 'docker-desktop'])
    await expect(
      stoppedWslDistroForRoot('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions')
    ).resolves.toBeNull()
  })

  it('matches distro names case-insensitively (Windows folds them)', async () => {
    _setRunningWslDistrosForTests(['ubuntu'])
    await expect(
      stoppedWslDistroForRoot('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions')
    ).resolves.toBeNull()
  })

  it('returns the distro name when it is confirmed stopped', async () => {
    _setRunningWslDistrosForTests(['docker-desktop'])
    await expect(
      stoppedWslDistroForRoot('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions')
    ).resolves.toBe('Ubuntu')
  })

  it('returns the distro name when nothing is running', async () => {
    _setRunningWslDistrosForTests([])
    await expect(
      stoppedWslDistroForRoot('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions')
    ).resolves.toBe('Ubuntu')
  })
})
