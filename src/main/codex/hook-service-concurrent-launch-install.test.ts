import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

const { getPathMock, homedirMock, installExclusivelyMock, refreshExclusivelyMock } = vi.hoisted(
  () => ({
    getPathMock: vi.fn<(name: string) => string>(),
    homedirMock: vi.fn<() => string>(),
    installExclusivelyMock: vi.fn<(runtimeHomePath: string) => Promise<AgentHookInstallStatus>>(),
    refreshExclusivelyMock: vi.fn<(runtimeHomePath: string) => Promise<AgentHookInstallStatus>>()
  })
)

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
vi.mock('./codex-hook-local-install', () => ({
  installCodexHooksExclusively: installExclusivelyMock
}))
vi.mock('./codex-hook-local-maintenance', () => ({
  refreshCodexRuntimeUserHooksExclusively: refreshExclusivelyMock,
  removeCodexHooksExclusively: vi.fn()
}))

import { CodexHookService } from './codex-hook-service-implementation'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

/** Stands in for a real `codex app-server` grant session, measured at ~380ms locally. */
const INSTALL_MS = 60

function installedStatus(configPath: string): AgentHookInstallStatus {
  return {
    agent: 'codex',
    state: 'installed',
    configPath,
    managedHooksPresent: true,
    detail: null
  }
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  installExclusivelyMock.mockImplementation(async (runtimeHomePath: string) => {
    await delay(INSTALL_MS)
    return installedStatus(join(runtimeHomePath, 'hooks.json'))
  })
  refreshExclusivelyMock.mockImplementation(async (runtimeHomePath: string) => {
    await delay(INSTALL_MS)
    return installedStatus(join(runtimeHomePath, 'hooks.json'))
  })
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('launch-prep Codex hook install sharing', () => {
  it('collapses a burst of concurrent launches into one install', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')

    const statuses = await Promise.all(
      Array.from({ length: 7 }, () => service.installForLaunchPrep(home))
    )

    expect(statuses.every((status) => status.state === 'installed')).toBe(true)
    expect(installExclusivelyMock).toHaveBeenCalledTimes(1)
  })

  it('re-installs for a launch that starts after the shared run settled', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')

    await Promise.all(Array.from({ length: 3 }, () => service.installForLaunchPrep(home)))
    await service.installForLaunchPrep(home)

    expect(installExclusivelyMock).toHaveBeenCalledTimes(2)
  })

  it('re-installs after a failed shared run instead of caching the failure', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')
    installExclusivelyMock.mockRejectedValueOnce(new Error('hooks.json unreadable'))

    await expect(service.installForLaunchPrep(home)).rejects.toThrow('hooks.json unreadable')
    await expect(service.installForLaunchPrep(home)).resolves.toMatchObject({
      state: 'installed'
    })
    expect(installExclusivelyMock).toHaveBeenCalledTimes(2)
  })

  it('never shares a run across different runtime homes', async () => {
    const service = new CodexHookService()

    await Promise.all([
      service.installForLaunchPrep(join(userDataDir, 'managed')),
      service.installForLaunchPrep(join(userDataDir, 'per-account'))
    ])

    expect(installExclusivelyMock).toHaveBeenCalledTimes(2)
    expect(installExclusivelyMock.mock.calls.map(([home]) => home)).toEqual([
      join(userDataDir, 'managed'),
      join(userDataDir, 'per-account')
    ])
  })

  it('never shares the install lane with the hooks-disabled refresh lane', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')

    await Promise.all([
      service.installForLaunchPrep(home),
      service.refreshRuntimeUserHooksForLaunchPrep(home)
    ])

    expect(installExclusivelyMock).toHaveBeenCalledTimes(1)
    expect(refreshExclusivelyMock).toHaveBeenCalledTimes(1)
  })

  it('leaves the direct install path unshared for settings-driven reinstalls', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')

    await Promise.all([service.install(home), service.install(home)])

    expect(installExclusivelyMock).toHaveBeenCalledTimes(2)
  })
})
