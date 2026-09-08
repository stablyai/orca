import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyAiVaultSearchSettings,
  applyAiVaultSearchSettingsChange,
  clearAiVaultSearchIndex,
  installAiVaultSearchSettingsSource,
  readAiVaultSearchIndexStatus,
  setSessionSearchIndexingChangeNotifier
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

vi.mock('../ai-vault/session-scanner-service-entry-path', () => ({
  getAiVaultServiceEntryPath: () => process.execPath
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
  it('refuses to acknowledge a policy change before the index path is known', async () => {
    await expect(
      applyAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: null } })
    ).rejects.toThrow('not initialized')
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

it('reports failed application rather than claiming the saved policy is effective', async () => {
  initSessionSearchPaths(await makeUserDataDir())
  configureAiVaultSearch.mockRejectedValueOnce(new Error('scanner unavailable'))
  await expect(
    applyAiVaultSearchSettings(
      { aiVaultSearch: { enabled: false, historyDays: null } },
      { clearIndex: true }
    )
  ).rejects.toThrow('scanner unavailable')
  expect(readAiVaultSearchIndexStatus().applied).toBe(false)
  await applyAiVaultSearchSettings({ aiVaultSearch: { enabled: false, historyDays: null } })
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

it('preserves the paused preference in scanner initialization and configuration', async () => {
  initSessionSearchPaths(await makeUserDataDir())
  const settings = { aiVaultSearch: { enabled: true, paused: true, historyDays: null } }
  installAiVaultSearchSettingsSource(() => settings)
  expect(getSessionSearchInitOptions()).toMatchObject({ paused: true })
  await applyAiVaultSearchSettings(settings)
  expect(configureAiVaultSearch).toHaveBeenCalledWith(
    expect.objectContaining({ paused: true }),
    expect.anything()
  )
})

it('retains failed durability in status until a complete transition succeeds', async () => {
  initSessionSearchPaths(await makeUserDataDir())
  const settings = { aiVaultSearch: { enabled: true, historyDays: null } }
  installAiVaultSearchSettingsSource(() => settings)
  await expect(
    applyAiVaultSearchSettings(settings, {
      persist: async () => {
        throw new Error('disk full')
      }
    })
  ).rejects.toThrow('disk full')
  expect(readAiVaultSearchIndexStatus()).toMatchObject({ enabled: true, applied: false })
  expect(readAiVaultSearchIndexStatus().reason).toContain('persistence')
  await applyAiVaultSearchSettings(settings, { persist: async () => undefined })
  expect(readAiVaultSearchIndexStatus()).toMatchObject({ applied: true })
})

it('flushes consent before the scanner is allowed to index under it', async () => {
  initSessionSearchPaths(await makeUserDataDir())
  const order: string[] = []
  configureAiVaultSearch.mockImplementation(async () => {
    order.push('configure')
    return null
  })

  await applyAiVaultSearchSettings(
    { aiVaultSearch: { enabled: true, historyDays: null } },
    {
      persist: async () => {
        order.push('persist')
      }
    }
  )

  expect(order).toEqual(['persist', 'configure'])
})

it('indexes nothing when the consent flush fails', async () => {
  initSessionSearchPaths(await makeUserDataDir())
  await expect(
    applyAiVaultSearchSettings(
      { aiVaultSearch: { enabled: true, historyDays: null } },
      {
        persist: async () => {
          throw new Error('disk full')
        }
      }
    )
  ).rejects.toThrow('disk full')

  // The next start reads the old policy, so anything written here would be indexed
  // content under a consent record that says search is off.
  expect(configureAiVaultSearch).not.toHaveBeenCalled()
  await applyAiVaultSearchSettings({ aiVaultSearch: { enabled: false, historyDays: null } })
})

it('does not mark a newer queued policy applied when an older flush completes', async () => {
  initSessionSearchPaths(await makeUserDataDir())
  let releaseFirst!: () => void
  const first = applyAiVaultSearchSettings(
    { aiVaultSearch: { enabled: true, historyDays: null } },
    {
      persist: () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    }
  )
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
  let releaseSecond!: () => void
  const second = applyAiVaultSearchSettings(
    { aiVaultSearch: { enabled: false, historyDays: null } },
    {
      persist: () =>
        new Promise<void>((resolve) => {
          releaseSecond = resolve
        })
    }
  )
  releaseFirst()
  await first
  expect(readAiVaultSearchIndexStatus().applied).toBe(false)
  await vi.waitFor(() => expect(releaseSecond).toBeTypeOf('function'))
  releaseSecond()
  await second
  expect(readAiVaultSearchIndexStatus().applied).toBe(true)
})

it('requires desktop clear to retry a failed policy flush before reporting applied', async () => {
  initSessionSearchPaths(await makeUserDataDir())
  const settings = { aiVaultSearch: { enabled: true, historyDays: null } }
  installAiVaultSearchSettingsSource(() => settings)
  const persist = vi.fn().mockRejectedValue(new Error('disk full'))
  await expect(applyAiVaultSearchSettings(settings, { persist })).rejects.toThrow('disk full')
  await expect(clearAiVaultSearchIndex(persist)).rejects.toThrow('disk full')
  expect(persist).toHaveBeenCalledTimes(2)
  expect(readAiVaultSearchIndexStatus().applied).toBe(false)
  persist.mockResolvedValue(undefined)
  await clearAiVaultSearchIndex(persist)
  expect(readAiVaultSearchIndexStatus().applied).toBe(true)
})

describe('applyAiVaultSearchSettingsChange', () => {
  it('does not reconfigure the scanner when the saved policy is unchanged', async () => {
    initSessionSearchPaths(await makeUserDataDir())
    const settings = { aiVaultSearch: { enabled: true, historyDays: 90 } }
    const persist = vi.fn()

    applyAiVaultSearchSettingsChange(
      settings,
      { aiVaultSearch: { ...settings.aiVaultSearch } },
      persist
    )
    // The apply chain is shared and serialized, so awaiting a later apply proves
    // the unchanged write never queued one of its own.
    await applyAiVaultSearchSettings({ aiVaultSearch: { enabled: false, historyDays: 90 } })

    expect(configureAiVaultSearch).toHaveBeenCalledTimes(1)
    expect(configureAiVaultSearch).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
      expect.anything()
    )
    expect(persist).not.toHaveBeenCalled()
  })

  it('forwards a pause that leaves consent and retention alone', async () => {
    initSessionSearchPaths(await makeUserDataDir())
    applyAiVaultSearchSettingsChange(
      { aiVaultSearch: { enabled: true, historyDays: 90 } },
      { aiVaultSearch: { enabled: true, historyDays: 90, paused: true } },
      () => undefined
    )

    await vi.waitFor(() =>
      expect(configureAiVaultSearch).toHaveBeenCalledWith(
        expect.objectContaining({ paused: true }),
        expect.anything()
      )
    )
  })

  it('reports a failed apply through the index status instead of throwing at the caller', async () => {
    initSessionSearchPaths(await makeUserDataDir())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    configureAiVaultSearch.mockRejectedValueOnce(new Error('scanner unavailable'))
    try {
      applyAiVaultSearchSettingsChange(
        { aiVaultSearch: { enabled: false, historyDays: null } },
        { aiVaultSearch: { enabled: true, historyDays: null } },
        () => undefined
      )
      await vi.waitFor(() => expect(readAiVaultSearchIndexStatus().applied).toBe(false))
      expect(readAiVaultSearchIndexStatus().reason).toContain('failed or is pending')
      // The scanner failure must have been absorbed, not left for the caller.
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[settings] failed to apply agent session search settings:',
          expect.any(Error)
        )
      )
    } finally {
      warn.mockRestore()
    }
    await applyAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: null } })
  })
})

describe('coverage change push', () => {
  afterEach(() => {
    setSessionSearchIndexingChangeNotifier(null)
  })

  it('tells the renderer to re-read once an apply has landed', async () => {
    initSessionSearchPaths(await makeUserDataDir())
    const notify = vi.fn()
    setSessionSearchIndexingChangeNotifier(notify)

    await applyAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: null } })
    // Why: the settings IPC does not await the apply, so a renderer reading coverage right after
    // its own control action can read the run that is being replaced.
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  })

  it('tells the renderer to re-read even when the apply failed', async () => {
    initSessionSearchPaths(await makeUserDataDir())
    const notify = vi.fn()
    setSessionSearchIndexingChangeNotifier(notify)
    configureAiVaultSearch.mockRejectedValueOnce(new Error('scanner unavailable'))

    await expect(
      applyAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: null } })
    ).rejects.toThrow('scanner unavailable')
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  })
})
