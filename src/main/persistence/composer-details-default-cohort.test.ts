import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createStore, testState, writeDataFile } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const legacyProfile = (settings: Record<string, unknown>) => ({
  schemaVersion: 1,
  repos: [],
  worktreeMeta: {},
  settings,
  ui: {},
  githubCache: { pr: {}, issue: {} },
  workspaceSession: {}
})

describe('composer details default cohort', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-composer-details-default-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('starts off for a new profile, stays off across restart, and keeps an opt-in', async () => {
    const store = createStore()
    expect(store.getSettings().nativeChatComposerDetails).toBe(false)
    await store.flushAsync()
    await closeTestStores()

    const reopened = createStore()
    expect(reopened.getSettings().nativeChatComposerDetails).toBe(false)
    reopened.updateSettings({ nativeChatComposerDetails: true })
    await reopened.flushAsync()
    await closeTestStores()

    expect(createStore().getSettings().nativeChatComposerDetails).toBe(true)
  })

  it('stays on for an existing profile without a choice and keeps an explicit opt-out', async () => {
    writeDataFile(legacyProfile({ theme: 'dark' }))
    const existing = createStore()
    expect(existing.getSettings().nativeChatComposerDetails).toBe(true)
    await existing.flushAsync()
    await closeTestStores()
    expect(createStore().getSettings().nativeChatComposerDetails).toBe(true)
    await closeTestStores()

    writeDataFile(legacyProfile({ nativeChatComposerDetails: false }))
    expect(createStore().getSettings().nativeChatComposerDetails).toBe(false)
  })
})
