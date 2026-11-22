import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repository/repo-types'
import { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let store: Store
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'repo-startup-policy-'))
  store = createStore()
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('changes only the startup policy, keeping a setup script saved after the caller read the repo', async () => {
  const listed: Repo = {
    id: 'repo-1',
    path: join(testState.dir, 'repo-1'),
    displayName: 'repo-1',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git'
  }
  store.addRepo(listed)
  const controller = new RuntimeRepositorySettingsController({
    getStore: () => store,
    // The row as the caller saw it, before the desktop saved its script.
    resolveRepo: async () => listed,
    forgetTerminalTopology: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn(),
    notifyWorktreesChanged: vi.fn()
  })
  store.updateRepo(listed, {
    hookSettings: {
      mode: 'override',
      setupRunPolicy: 'ask',
      scripts: { setup: 'pnpm install', archive: 'pnpm clean' }
    }
  })

  await controller.update('repo-1', { setupAgentStartupPolicy: 'wait-for-setup' })

  expect(store.getRepo('repo-1')?.hookSettings).toEqual({
    mode: 'override',
    setupRunPolicy: 'ask',
    setupAgentStartupPolicy: 'wait-for-setup',
    scripts: { setup: 'pnpm install', archive: 'pnpm clean' }
  })
})
