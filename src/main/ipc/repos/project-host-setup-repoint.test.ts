import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repo-types'
import { registerProjectHostSetupHandlers } from './project-host-setup-handlers'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))

async function invoke(channel: string, args: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`Handler not registered: ${channel}`)
  }
  return handler(undefined, args)
}

let store: Store
beforeEach(() => {
  handlers.clear()
  testState.dir = mkdtempSync(join(tmpdir(), 'project-repoint-setup-'))
  store = createStore()
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('repointing a moved folder project through the setup handler', () => {
  it('records the requested setup method on a repointed row that has none', async () => {
    const oldPath = join(testState.dir, 'moved')
    const newPath = join(testState.dir, 'moved-new')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seed row only exercises the folder-project fields the repoint flow reads; the in-memory test store persists it verbatim.
    store.addRepo({
      id: 'repo-1',
      path: oldPath,
      displayName: 'repo-1',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    } as Repo)
    mkdirSync(newPath)
    registerProjectHostSetupHandlers(new BrowserWindow(), store)
    const setup = store.getProjectHostSetups().find((entry) => entry.repoId === 'repo-1')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler's success payload always carries the updated repo row; only that member is asserted on.
    const result = (await invoke('projectHostSetups:setupExistingFolder', {
      projectId: setup!.projectId,
      hostId: 'local',
      path: newPath,
      kind: 'folder',
      setupMethod: 'imported-existing-folder'
    })) as { repo: Repo }

    expect(result.repo).toMatchObject({
      id: 'repo-1',
      path: newPath,
      projectHostSetupMethod: 'imported-existing-folder'
    })
  })
})
