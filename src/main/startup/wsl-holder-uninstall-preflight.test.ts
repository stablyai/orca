import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn(), getPath: vi.fn() } }))

import type { WslDistroHolder } from '../wsl/wsl-distro-holder'
import type { WslHostUninstallStopDependencies } from '../wsl/wsl-host-uninstall-server-stop'
import { releaseWslHoldersForUninstall } from './wsl-holder-uninstall-preflight'

function holderReleasing(states: { distro: string; state: string }[]): WslDistroHolder {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preflight only calls releaseAll.
  return { releaseAll: vi.fn(async () => states) } as unknown as WslDistroHolder
}

function servers(order: string[]): WslHostUninstallStopDependencies {
  return {
    distros: () => ['Ubuntu'],
    listRunning: async () => ['Ubuntu'],
    stop: vi.fn(async () => {
      order.push('stop-server')
      return { stopped: true as const }
    })
  }
}

describe('releaseWslHoldersForUninstall', () => {
  it('stops the running hosts’ servers after releasing the holders', async () => {
    const order: string[] = []
    const holder = holderReleasing([{ distro: 'Ubuntu', state: 'exited' }])
    vi.mocked(holder.releaseAll).mockImplementation(async () => {
      order.push('release-holders')
      return [{ distro: 'Ubuntu', state: 'exited' }]
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(releaseWslHoldersForUninstall(holder, servers(order))).resolves.toBe(0)
    expect(order).toEqual(['release-holders', 'stop-server'])
  })

  it('keeps the holder verdict as the exit code whatever the server stop does', async () => {
    const holder = holderReleasing([{ distro: 'Ubuntu', state: 'unverifiable' }])
    const failing: WslHostUninstallStopDependencies = {
      distros: () => {
        throw new Error('records unreadable')
      },
      listRunning: async () => [],
      stop: vi.fn()
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(releaseWslHoldersForUninstall(holder, failing)).resolves.toBe(1)
  })
})
