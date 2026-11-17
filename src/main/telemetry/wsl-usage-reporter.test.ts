import { describe, expect, it, vi } from 'vitest'
import { listRunningDistrosForSnapshot } from './wsl-usage-reporter'

describe('listRunningDistrosForSnapshot', () => {
  it('probes no running list when no Orca project uses WSL', async () => {
    const probe = vi.fn(async () => ['Ubuntu'])
    await expect(
      listRunningDistrosForSnapshot([{ distro: 'Ubuntu' }], false, () => null, probe)
    ).resolves.toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })
})
