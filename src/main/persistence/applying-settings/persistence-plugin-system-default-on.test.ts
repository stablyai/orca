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

describe('plugin system default-on migration', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('turns plugins on for new profiles', async () => {
    const store = await createStore()
    expect(store.getSettings().pluginSystemEnabled).toBe(true)
    expect(store.getSettings().pluginSystemDefaultedOn).toBe(true)
  })

  it('flips a saved pre-rollout false on once', async () => {
    writeSettings({ pluginSystemEnabled: false })
    const store = await createStore()
    expect(store.getSettings().pluginSystemEnabled).toBe(true)
    expect(store.getSettings().pluginSystemDefaultedOn).toBe(true)
  })

  it('keeps a deliberate false saved after the migration', async () => {
    writeSettings({ pluginSystemEnabled: false, pluginSystemDefaultedOn: true })
    const store = await createStore()
    expect(store.getSettings().pluginSystemEnabled).toBe(false)
  })

  it('stamps the guard on explicit writes so they survive reload', async () => {
    const store = await createStore()
    const updated = store.updateSettings({
      pluginSystemEnabled: false,
      pluginSystemDefaultedOn: false
    })
    expect(updated.pluginSystemEnabled).toBe(false)
    expect(updated.pluginSystemDefaultedOn).toBe(true)
  })
})
