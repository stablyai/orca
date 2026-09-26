import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, makeRepo, testState } from '../persistence-test-harness'
import { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'

vi.mock('../ipc/filesystem-auth', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
vi.mock('../worktree-root-preparation', () => ({ prepareLocalWorktreeRootForRepo: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-visibility-host-'))
})
afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('repository visibility owner selection', () => {
  it.each(['show', 'hide', null] as const)(
    'updates only the selected host for %s',
    async (visibility) => {
      const store = createStore()
      store.addRepo(
        makeRepo({ id: 'shared', path: '/local/repo', externalWorktreeVisibility: 'hide' })
      )
      store.addRepo(
        makeRepo({
          id: 'shared',
          path: '/remote/repo',
          executionHostId: 'ssh:server',
          connectionId: 'server',
          externalWorktreeVisibility: 'show'
        })
      )
      const controller = new RuntimeRepositorySettingsController({
        getStore: () => store,
        resolveRepo: async (selector) => {
          const repo = store.getRepos().find((entry) => entry.path === selector)
          if (!repo) {
            throw new Error('repo_not_found')
          }
          return repo
        },
        forgetTerminalTopology: vi.fn(),
        invalidateResolvedWorktrees: vi.fn(),
        invalidateWorktreeScan: vi.fn(),
        notifyReposChanged: vi.fn()
      })
      const updated = await controller.update('/remote/repo', {
        externalWorktreeVisibility: visibility
      })
      expect(updated.path).toBe('/remote/repo')
      expect(updated.externalWorktreeVisibility ?? null).toBe(visibility)
      expect(
        store.getRepos().find((repo) => repo.path === '/local/repo')?.externalWorktreeVisibility
      ).toBe('hide')
      await store.flushPendingOrThrowAsync()
    }
  )
})
