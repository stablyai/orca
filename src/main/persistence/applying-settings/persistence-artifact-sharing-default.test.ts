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

describe('artifact sharing default', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('allows publishing on a new profile and keeps it after a reload', async () => {
    const store = createStore()
    expect(store.getSettings().artifactSharingEnabled).toBe(true)
    store.flush()
    await closeTestStores()
    expect(createStore().getSettings().artifactSharingEnabled).toBe(true)
  })

  it('keeps a stored opt-out', () => {
    writeSettings({ artifactSharingEnabled: false })
    expect(createStore().getSettings().artifactSharingEnabled).toBe(false)
  })

  it('keeps publishing off for a stored profile saved before the setting existed', () => {
    writeSettings({ showArtifactsButton: false })
    expect(createStore().getSettings().artifactSharingEnabled).toBe(false)
  })
})
