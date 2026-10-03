import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

const { getPathMock, homedirMock, refreshExclusivelyMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  refreshExclusivelyMock: vi.fn<(runtimeHomePath: string) => Promise<AgentHookInstallStatus>>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
vi.mock('./codex-hook-local-maintenance', () => ({
  refreshCodexRuntimeUserHooksExclusively: refreshExclusivelyMock,
  removeCodexHooksExclusively: vi.fn()
}))

import { CodexHookService } from './codex-hook-service-implementation'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

/** Stands in for the hooks.json + config.toml rewrite and system-config promotion. */
const REFRESH_MS = 60

function refreshedStatus(configPath: string): AgentHookInstallStatus {
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
  refreshExclusivelyMock.mockImplementation(async (runtimeHomePath: string) => {
    await delay(REFRESH_MS)
    return refreshedStatus(join(runtimeHomePath, 'hooks.json'))
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

describe('launch-prep Codex user-hook refresh sharing', () => {
  it('collapses a burst of concurrent launches into one refresh', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')

    const statuses = await Promise.all(
      Array.from({ length: 7 }, () => service.refreshRuntimeUserHooksForLaunchPrep(home))
    )

    expect(statuses.every((status) => status.state === 'installed')).toBe(true)
    expect(refreshExclusivelyMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes again for a launch that starts after the shared run settled', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')

    await Promise.all(
      Array.from({ length: 3 }, () => service.refreshRuntimeUserHooksForLaunchPrep(home))
    )
    await service.refreshRuntimeUserHooksForLaunchPrep(home)

    expect(refreshExclusivelyMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes again after a failed shared run instead of caching the failure', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')
    refreshExclusivelyMock.mockRejectedValueOnce(new Error('hooks.json unreadable'))

    await expect(service.refreshRuntimeUserHooksForLaunchPrep(home)).rejects.toThrow(
      'hooks.json unreadable'
    )
    await expect(service.refreshRuntimeUserHooksForLaunchPrep(home)).resolves.toMatchObject({
      state: 'installed'
    })
    expect(refreshExclusivelyMock).toHaveBeenCalledTimes(2)
  })

  it('never shares a run across different runtime homes', async () => {
    const service = new CodexHookService()

    await Promise.all([
      service.refreshRuntimeUserHooksForLaunchPrep(join(userDataDir, 'managed')),
      service.refreshRuntimeUserHooksForLaunchPrep(join(userDataDir, 'per-account'))
    ])

    expect(refreshExclusivelyMock).toHaveBeenCalledTimes(2)
    expect(refreshExclusivelyMock.mock.calls.map(([home]) => home)).toEqual([
      join(userDataDir, 'managed'),
      join(userDataDir, 'per-account')
    ])
  })

  it('leaves the direct refresh path unshared for retained-home reconciliation', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')

    await Promise.all([
      service.refreshRuntimeUserHooks(home),
      service.refreshRuntimeUserHooks(home)
    ])

    expect(refreshExclusivelyMock).toHaveBeenCalledTimes(2)
  })
})
