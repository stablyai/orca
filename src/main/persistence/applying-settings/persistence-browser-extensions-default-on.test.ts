import { closeTestStores, testState, createStore, writeDataFile } from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

function writeSettings(settings: Record<string, unknown>): void {
  writeDataFile({
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings,
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {}
  })
}

describe('browser extensions default-on migration', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('turns extensions on for new profiles', async () => {
    const store = await createStore()
    expect(store.getSettings().experimentalBrowserExtensions).toBe(true)
    expect(store.getSettings().browserExtensionsDefaultedOn).toBe(true)
  })

  it('flips a saved pre-rollout false on once', async () => {
    writeSettings({ experimentalBrowserExtensions: false })
    const store = await createStore()
    expect(store.getSettings().experimentalBrowserExtensions).toBe(true)
    expect(store.getSettings().browserExtensionsDefaultedOn).toBe(true)
  })

  it('keeps a deliberate false saved after the migration', async () => {
    writeSettings({ experimentalBrowserExtensions: false, browserExtensionsDefaultedOn: true })
    const store = await createStore()
    expect(store.getSettings().experimentalBrowserExtensions).toBe(false)
  })

  it('stamps the guard on explicit writes so they survive reload', async () => {
    const store = await createStore()
    const updated = store.updateSettings({
      experimentalBrowserExtensions: false,
      browserExtensionsDefaultedOn: false
    })
    expect(updated.experimentalBrowserExtensions).toBe(false)
    expect(updated.browserExtensionsDefaultedOn).toBe(true)
  })
})
