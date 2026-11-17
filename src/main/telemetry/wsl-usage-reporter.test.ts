import { describe, expect, it, vi } from 'vitest'
import { listRunningDistrosForSnapshot } from './wsl-usage-reporter'

describe('listRunningDistrosForSnapshot', () => {
  const registrations = [{ distro: 'Ubuntu' }]

  it('probes no running list when no legacy project uses a distro', async () => {
    const probe = vi.fn(async () => ['Ubuntu'])
    await expect(
      listRunningDistrosForSnapshot(
        registrations,
        () => null,
        probe,
        () => ({ distros: [], defaultDistro: false })
      )
    ).resolves.toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })
})
