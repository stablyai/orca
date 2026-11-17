import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wsl = vi.hoisted(() => ({
  readRunningHomes: vi.fn(async () => ({
    homes: ['\\\\wsl.localhost\\Ubuntu\\home\\u', '\\\\wsl.localhost\\Debian\\home\\u'],
    confirmed: true
  }))
}))

vi.mock('../../wsl/discovery/distro-catalog', () => ({
  hasCachedWslDistros: () => true,
  getCachedWslDistros: () => ['Ubuntu', 'Debian']
}))
vi.mock('../../wsl/discovery/wsl-home-unless-stopped', () => ({
  readRunningWslHomeDirsUnlessStopped: wsl.readRunningHomes,
  listLastKnownRunningWslHomeDirs: async () => []
}))

import { getAiVaultWslScanHomeDirs } from './ai-vault-scan-roots'

const realPlatform = process.platform

// Review repro for #43496: sessions in a running distro must never vanish because no saved
// project, tab or mapped drive names it (per-tab WSL shells, worktrees elsewhere, `net use`).
describe('AI vault WSL scan homes', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  it('scans every running distro, whatever the saved projects use', async () => {
    await expect(getAiVaultWslScanHomeDirs()).resolves.toEqual([
      '\\\\wsl.localhost\\Ubuntu\\home\\u',
      '\\\\wsl.localhost\\Debian\\home\\u'
    ])
  })
})
