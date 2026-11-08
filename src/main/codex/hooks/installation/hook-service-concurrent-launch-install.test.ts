import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookHashLookup from '../../trust/hooks/codex-hook-hash-lookup'
import type * as CodexHookLocalInstall from './codex-hook-local-install'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import type {
  CodexHookAnswer,
  CodexHookHashes
} from '../../trust/hooks/codex-hook-trust-derivation'

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
vi.mock('../../trust/hooks/codex-hook-hash-lookup', async (importOriginal) => ({
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
  it("never joins a Codex launch to a plain terminal's run that went ahead without the answer", async () => {
    const service = new CodexHookService()
    const home = join(userDataDir, 'managed')
    // Model a delayed answer available only to launches that wait for it.
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

    expect(installExclusivelyMock.mock.calls.map(([, hashes]) => hashes)).toContainEqual(
      codexHashes
    )
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
})
