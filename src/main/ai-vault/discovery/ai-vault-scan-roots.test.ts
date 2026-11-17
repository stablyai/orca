import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LegacyWslDemandModule from '../../wsl/discovery/legacy-wsl-demand'
import type { LegacyWslDemand } from '../../wsl/discovery/legacy-wsl-demand'

const wsl = vi.hoisted(() => {
  const unknownDemand = (): LegacyWslDemand | null => null
  return {
    demand: unknownDemand(),
    readRunningHomes: vi.fn(async (scope?: (running: string[]) => string[]) => ({
      homes: (scope ? scope(['Ubuntu', 'Debian']) : ['Ubuntu', 'Debian']).map(
        (distro) => `\\\\wsl.localhost\\${distro}\\home\\u`
      ),
      confirmed: true
    }))
  }
})

vi.mock('../../wsl/discovery/distro-catalog', () => ({
  hasCachedWslDistros: () => false,
  getCachedWslDistros: () => null
}))
vi.mock('../../wsl/discovery/wsl-home-unless-stopped', () => ({
  readRunningWslHomeDirsUnlessStopped: wsl.readRunningHomes,
  listLastKnownRunningWslHomeDirs: async () => []
}))
vi.mock('../../wsl/discovery/legacy-wsl-demand', async (original) => ({
  ...(await original<typeof LegacyWslDemandModule>()),
  currentLegacyWslDemand: () => wsl.demand
}))
vi.mock('../../wsl/discovery/wsl-default-distro', () => ({
  resolveWslDefaultDistro: async () => 'Debian'
}))

import { getAiVaultWslScanHomeDirs } from './ai-vault-scan-roots'

const realPlatform = process.platform

describe('AI vault WSL scan homes', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    wsl.readRunningHomes.mockClear()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  it('reads no running distros when no legacy project uses WSL', async () => {
    wsl.demand = { distros: [], defaultDistro: false }
    await expect(getAiVaultWslScanHomeDirs()).resolves.toEqual([])
    expect(wsl.readRunningHomes).not.toHaveBeenCalled()
  })

  it('scans only the distros legacy projects or the default WSL terminal use', async () => {
    wsl.demand = { distros: ['ubuntu'], defaultDistro: false }
    await expect(getAiVaultWslScanHomeDirs()).resolves.toEqual([
      '\\\\wsl.localhost\\Ubuntu\\home\\u'
    ])
    wsl.demand = { distros: [], defaultDistro: true }
    await expect(getAiVaultWslScanHomeDirs()).resolves.toEqual([
      '\\\\wsl.localhost\\Debian\\home\\u'
    ])
  })
})
