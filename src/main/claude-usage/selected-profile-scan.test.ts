import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = vi.hoisted(() => ({
  userData: '',
  scan: vi.fn(async () => ({ sessions: [], dailyAggregates: [] }))
}))
vi.mock('electron', () => ({ app: { getPath: () => fixture.userData } }))
vi.mock('../usage/scan-worker/usage-scan-worker-spawn', () => ({
  scanClaudeUsageFilesViaWorker: fixture.scan,
  splitUsageCacheFileViaWorker: vi.fn()
}))

import { createTestUsageStoreHost } from '../usage/usage-store-host-test-fixture'
import { ClaudeUsageStore } from './store'

let store: ClaudeUsageStore | undefined

afterEach(async () => {
  await store?.flush()
  if (fixture.userData) {
    rmSync(fixture.userData, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

it('resolves the current profile roots for each worker scan', async () => {
  fixture.userData = mkdtempSync(join(tmpdir(), 'orca-selected-profile-scan-'))
  let selected = ['selected/projects', 'selected/transcripts']
  store = new ClaudeUsageStore({
    ...createTestUsageStoreHost({ userDataPath: fixture.userData }),
    claudeProfileDirs: async () => selected
  })
  await store.setEnabled(true)
  await store.refresh(true)
  expect(fixture.scan).toHaveBeenLastCalledWith([], expect.objectContaining({ reuse: false }), [
    'selected/projects',
    'selected/transcripts'
  ])
  selected = ['next/projects', 'next/transcripts']
  await store.refresh(true)
  expect(fixture.scan).toHaveBeenLastCalledWith([], expect.objectContaining({ reuse: true }), [
    'next/projects',
    'next/transcripts'
  ])
})
