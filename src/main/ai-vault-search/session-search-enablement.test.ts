import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyAiVaultSearchSettings,
  installAiVaultSearchSettingsSource,
  readAiVaultSearchIndexStatus
} from './session-search-enablement'
import {
  getSessionSearchInitOptions,
  initSessionSearchPaths,
  resetSessionSearchPathsForTests
} from './session-search-paths'
import { resetSessionSearchPolicyForTests } from './session-search-policy'

const configureAiVaultSearch = vi.fn()
vi.mock('../ai-vault/cached-session-list', () => ({
  configureAiVaultSearch: (...args: unknown[]) => configureAiVaultSearch(...args)
}))

let tempRoots: string[] = []

beforeEach(() => {
  configureAiVaultSearch.mockReset().mockResolvedValue(null)
  resetSessionSearchPathsForTests()
  resetSessionSearchPolicyForTests()
})

afterEach(async () => {
  resetSessionSearchPathsForTests()
  resetSessionSearchPolicyForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeUserDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-enablement-'))
  tempRoots.push(root)
  return root
}

describe('session search policy source', () => {
  it('reports search off until a source is installed', () => {
    expect(readAiVaultSearchIndexStatus()).toMatchObject({ enabled: false, historyDays: null })
  })

  it('reads the live settings on every spawn rather than a captured snapshot', async () => {
    initSessionSearchPaths(await makeUserDataDir())
    const settings: { aiVaultSearch?: { enabled: boolean; historyDays: number | null } } = {}
    installAiVaultSearchSettingsSource(() => settings)

    expect(getSessionSearchInitOptions()).toMatchObject({ enabled: false, historyDays: null })

    settings.aiVaultSearch = { enabled: true, historyDays: 90 }
    expect(getSessionSearchInitOptions()).toMatchObject({ enabled: true, historyDays: 90 })
  })

  it('normalizes a nonsensical persisted history bound to all history', async () => {
    initSessionSearchPaths(await makeUserDataDir())
    installAiVaultSearchSettingsSource(() => ({
      aiVaultSearch: { enabled: true, historyDays: -5 }
    }))

    expect(getSessionSearchInitOptions()).toMatchObject({ enabled: true, historyDays: null })
  })
})

describe('applyAiVaultSearchSettings', () => {
  it('does nothing before the index path is known', async () => {
    await expect(
      applyAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: null } })
    ).resolves.toBeNull()
    expect(configureAiVaultSearch).not.toHaveBeenCalled()
  })

  it('pushes the resolved policy and the clear request to the running scanner', async () => {
    const userData = await makeUserDataDir()
    initSessionSearchPaths(userData)

    await applyAiVaultSearchSettings(
      { aiVaultSearch: { enabled: true, historyDays: 30 } },
      { clearIndex: true }
    )

    expect(configureAiVaultSearch).toHaveBeenCalledWith(
      {
        databasePath: join(userData, 'ai-vault-search', 'index.sqlite'),
        enabled: true,
        historyDays: 30
      },
      { clearIndex: true }
    )
  })
})

describe('readAiVaultSearchIndexStatus', () => {
  it('reports no size when the database file is absent', async () => {
    initSessionSearchPaths(await makeUserDataDir())
    expect(readAiVaultSearchIndexStatus().indexSizeBytes).toBeNull()
  })

  it('sums the database and its WAL sidecars', async () => {
    const userData = await makeUserDataDir()
    initSessionSearchPaths(userData)
    const databasePath = join(userData, 'ai-vault-search', 'index.sqlite')
    await mkdir(join(userData, 'ai-vault-search'), { recursive: true })
    await writeFile(databasePath, 'x'.repeat(100))
    await writeFile(`${databasePath}-wal`, 'y'.repeat(23))

    expect(readAiVaultSearchIndexStatus().indexSizeBytes).toBe(123)
  })

  it('treats a leftover sidecar without the database as no index', async () => {
    const userData = await makeUserDataDir()
    initSessionSearchPaths(userData)
    await mkdir(join(userData, 'ai-vault-search'), { recursive: true })
    await writeFile(join(userData, 'ai-vault-search', 'index.sqlite-wal'), 'y'.repeat(23))

    expect(readAiVaultSearchIndexStatus().indexSizeBytes).toBeNull()
  })
})
