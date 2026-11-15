/** Host-owned project removal stops even hidden/unhydrated workspace shells that no client can sweep. */
import { describe, expect, it, vi } from 'vitest'

import { spawnWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

import type { Repo } from '../../../../shared/repository/repo-types'

import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'

import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  store
} from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'

describe('project removal on the execution host', () => {
  it('refuses a spawn that reaches its lease after the project is gone', async () => {
    let removed = false
    const repo = store.getRepo(TEST_REPO_ID)!
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => (id === TEST_REPO_ID && !removed ? repo : undefined),
      getRepos: () => (removed ? [] : [repo]),
      removeProjectForHost: () => {
        removed = true
      }
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.removeProject(TEST_REPO_ID)

    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, null))
    ).rejects.toThrow('repo_not_found')
  })

  it('refuses an SSH spawn after removal even though a local same-id sibling survives', async () => {
    const localRow = store.getRepo(TEST_REPO_ID)!
    const sshRow: Repo = { ...localRow, path: '/srv/ssh-copy', connectionId: 'ssh-target' }
    let rows = [localRow, sshRow]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => rows.find((row) => row.id === id),
      getRepos: () => rows,
      removeProjectForHost: () => {
        rows = [localRow]
      }
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.removeProject('path:/srv/ssh-copy')

    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, 'ssh-target'))
    ).rejects.toThrow('repo_not_found')
    const releaseLocal = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(TEST_WORKTREE_ID, null)
    )
    releaseLocal()
  })

  it('keeps admitting a self-stamped row after its SSH twin is removed', async () => {
    const sshRow: Repo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-target' }
    // A paired client's registration: the runtime stamp names files on this host.
    const selfRow: Repo = { ...store.getRepo(TEST_REPO_ID)!, executionHostId: 'runtime:env-self' }
    let rows = [sshRow, selfRow]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => rows.find((row) => row.id === id),
      getRepos: () => rows,
      removeProjectForHost: () => {
        rows = [selfRow]
      }
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.removeProject(sshRow)

    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, 'ssh-target'))
    ).rejects.toThrow('repo_not_found')
    const releaseLocal = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(TEST_WORKTREE_ID, null)
    )
    releaseLocal()
  })
})
