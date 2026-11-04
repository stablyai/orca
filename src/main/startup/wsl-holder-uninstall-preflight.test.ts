import { afterEach, describe, expect, it, vi } from 'vitest'

const { exit, stopServers, releaseAll } = vi.hoisted(() => ({
  exit: vi.fn(),
  stopServers: vi.fn(async () => {}),
  releaseAll: vi.fn(async (): Promise<{ distro: string; state: string }[]> => [])
}))
vi.mock('electron', () => ({
  app: { exit, getPath: () => 'C:\\Users\\u\\AppData\\Roaming\\orca' }
}))
vi.mock('./windows-app-data-path', () => ({ ensureWindowsAppDataPath: vi.fn() }))
vi.mock('../wsl/discovery/wsl-distro-holder', () => ({
  createWslDistroHolder: () => ({ releaseAll })
}))
vi.mock('../wsl/host-lifecycle/wsl-host-uninstall-server-stop', () => ({
  stopWslHostServersForUninstall: stopServers,
  wslHostUninstallStopDependencies: () => ({ distros: () => [], listRunning: async () => [] })
}))

import type { WslDistroHolder } from '../wsl/discovery/wsl-distro-holder-types'
import type { WslHostUninstallStopDependencies } from '../wsl/host-lifecycle/wsl-host-uninstall-server-stop'
import {
  releaseWslHoldersForUninstall,
  runWslHolderUninstallPreflight,
  WSL_HOLDER_UNINSTALL_FLAG,
  WSL_SERVER_UNINSTALL_FLAG
} from './wsl-holder-uninstall-preflight'

function holderReleasing(states: { distro: string; state: string }[]): WslDistroHolder {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preflight only calls releaseAll.
  return { releaseAll: vi.fn(async () => states) } as unknown as WslDistroHolder
}

const SERVERS: WslHostUninstallStopDependencies = {
  distros: () => ['Ubuntu'],
  listRunning: async () => ['Ubuntu'],
  stop: vi.fn()
}

describe('releaseWslHoldersForUninstall', () => {
  afterEach(() => {
    stopServers.mockReset()
    stopServers.mockImplementation(async () => {})
  })

  it('stops the running hosts’ servers before releasing the holders that keep their distros up', async () => {
    const order: string[] = []
    const holder = holderReleasing([])
    vi.mocked(holder.releaseAll).mockImplementation(async () => {
      order.push('release-holders')
      return [{ distro: 'Ubuntu', state: 'exited' }]
    })
    stopServers.mockImplementation(async () => {
      order.push('stop-servers')
    })

    await expect(releaseWslHoldersForUninstall(holder, SERVERS)).resolves.toBe(0)
    expect(order).toEqual(['stop-servers', 'release-holders'])
  })

  it('keeps the holder verdict as the exit code whatever the server stop does', async () => {
    stopServers.mockRejectedValue(new Error('records unreadable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      releaseWslHoldersForUninstall(
        holderReleasing([{ distro: 'U', state: 'unverifiable' }]),
        SERVERS
      )
    ).resolves.toBe(1)
  })
})

describe('runWslHolderUninstallPreflight', () => {
  afterEach(() => {
    stopServers.mockClear()
    exit.mockClear()
  })

  it('leaves the servers alone unless the uninstaller says this is the last install', async () => {
    expect(runWslHolderUninstallPreflight(['Orca.exe', WSL_HOLDER_UNINSTALL_FLAG])).toBe(true)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))

    expect(stopServers).not.toHaveBeenCalled()
  })

  it('stops the servers when the uninstaller adds the server flag', async () => {
    runWslHolderUninstallPreflight([
      'Orca.exe',
      WSL_HOLDER_UNINSTALL_FLAG,
      WSL_SERVER_UNINSTALL_FLAG
    ])
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))

    expect(stopServers).toHaveBeenCalledTimes(1)
  })
})
