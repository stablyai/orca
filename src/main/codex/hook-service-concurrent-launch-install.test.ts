import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookHashLookup from './codex-hook-hash-lookup'
import type * as CodexHookLocalInstall from './codex-hook-local-install'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { CodexHookAnswer, CodexHookHashes } from './codex-hook-trust-derivation'

const { getPathMock, homedirMock, installExclusivelyMock, refreshExclusivelyMock, answerMock } =
  vi.hoisted(() => ({
    getPathMock: vi.fn<(name: string) => string>(),
    homedirMock: vi.fn<() => string>(),
    installExclusivelyMock:
      vi.fn<
        (runtimeHomePath: string, hashes: CodexHookHashes) => Promise<AgentHookInstallStatus>
      >(),
    refreshExclusivelyMock: vi.fn<(runtimeHomePath: string) => Promise<AgentHookInstallStatus>>(),
    answerMock: vi.fn<(waitMs: number) => Promise<CodexHookAnswer | null>>()
  }))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
vi.mock('./codex-hook-local-install', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookLocalInstall>()),
  installCodexHooksExclusively: installExclusivelyMock
}))
// Why: stands in for asking a real Codex for its hook hashes.
vi.mock('./codex-hook-hash-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookHashLookup>()),
  resolveCodexHookAnswerForLaunch: answerMock
}))
vi.mock('./codex-hook-local-maintenance', () => ({
  refreshCodexRuntimeUserHooksExclusively: refreshExclusivelyMock,
  removeCodexHooksExclusively: vi.fn()
}))

import { CodexHookService } from './codex-hook-service-implementation'
import { codexHookAnswerForTests } from './hook-service-test-harness'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

/** Stands in for a managed-home install's file writes. */
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
  answerMock.mockImplementation(async () => codexHookAnswerForTests())
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
      Array.from({ length: 7 }, () => service.installForLaunchPrep(home, false, () => true))
    )

    expect(statuses.every((status) => status.state === 'installed')).toBe(true)
    expect(installExclusivelyMock).toHaveBeenCalledTimes(1)
  })

  it("never joins a Codex launch to a plain terminal's run that went ahead without the answer", async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')
    // Why: Codex answers 20 ms in; a plain terminal waits 0 ms, a Codex launch up to 3 s.
    const codexHashes = { stop: 'sha256:from-codex' }
    answerMock.mockImplementation(async (waitMs) => {
      await delay(Math.min(waitMs, 20))
      return waitMs > 0
        ? { kind: 'hashes', codexVersion: 'codex-cli 0.160.1', hashes: codexHashes }
        : null
    })

    await Promise.all([
      service.installForLaunchPrep(home, false, () => true),
      service.installForLaunchPrep(home, true, () => true)
    ])

    // Why: the plain terminal goes ahead on Orca's own hash; the Codex launch still gets Codex's.
    expect(installExclusivelyMock.mock.calls.map(([, hashes]) => hashes)).toContainEqual(
      codexHashes
    )
  })

  it('re-installs for a launch that starts after the shared run settled', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')

    await Promise.all(
      Array.from({ length: 3 }, () => service.installForLaunchPrep(home, false, () => true))
    )
    await service.installForLaunchPrep(home, false, () => true)

    expect(installExclusivelyMock).toHaveBeenCalledTimes(2)
  })

  it('re-installs after a failed shared run instead of caching the failure', async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')
    installExclusivelyMock.mockRejectedValueOnce(new Error('hooks.json unreadable'))

    await expect(service.installForLaunchPrep(home, false, () => true)).rejects.toThrow(
      'hooks.json unreadable'
    )
    await expect(service.installForLaunchPrep(home, false, () => true)).resolves.toMatchObject({
      state: 'installed'
    })
    expect(installExclusivelyMock).toHaveBeenCalledTimes(2)
  })

  it('never shares a run across different runtime homes', async () => {
    const service = new CodexHookService()

    await Promise.all([
      service.installForLaunchPrep(join(userDataDir, 'managed'), false, () => true),
      service.installForLaunchPrep(join(userDataDir, 'per-account'), false, () => true)
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
      service.installForLaunchPrep(home, false, () => true),
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
