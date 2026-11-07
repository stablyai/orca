import { closeTestStores, testState, createStore, writeDataFile } from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

describe('Store voice settings', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('moves a retired speech model selection to its replacement', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { voice: { enabled: true, sttModel: 'zipformer-streaming-en-20m' } },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().voice).toMatchObject({
      enabled: true,
      sttModel: 'parakeet-tdt-0.6b-v2-int8'
    })
  })
})
