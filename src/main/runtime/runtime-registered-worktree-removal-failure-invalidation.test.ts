// A runtime server caches its worktree listings, so a removal that fails after git already dropped
// the worktree must clear that cache before the watcher gate is released, as a successful one does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerWorktreeChangeInvalidator } from '../ipc/worktree-change-invalidators'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { RuntimeStore } from './runtime-store-contract'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'
import { removeRuntimeRegisteredRemoteWorktree } from './runtime-registered-remote-worktree-removal'

const { removeWorktreeMock } = vi.hoisted(() => ({ removeWorktreeMock: vi.fn() }))

vi.mock('../git/worktree', () => ({
  assertWorktreeCleanForRemoval: vi.fn(async () => undefined),
  listWorktreesStrict: vi.fn(async () => [featureRow]),
  removeWorktree: removeWorktreeMock
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn(async () => ({ stdout: '' })) }))
vi.mock('../git/worktree-shared-directories', () => ({ getWorktreeSharedLinkPaths: () => [] }))
vi.mock('../hooks', () => ({ getEffectiveHooks: () => undefined, runHook: vi.fn() }))
vi.mock('../ipc/worktree-symlinks', () => ({
  findExistingWorktreeSymlinkPaths: vi.fn(async () => []),
  removeWorktreeLinkedPaths: vi.fn(async () => undefined)
}))
vi.mock('../ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: vi.fn(async () => undefined),
  cleanupUnusedWorktreePushTargetRemoteSsh: vi.fn(async () => undefined)
}))
vi.mock('../worktree-archive-hook-gate', () => ({
  gateWorktreeRemovalOnArchiveHook: vi.fn(),
  gateRemovalWhereArchiveHookCannotRun: vi.fn(async () => ({}))
}))
vi.mock('../worktree-removal-safety', () => ({
  findRegisteredDeletableWorktree: () => featureRow
}))
vi.mock('../local-worktree-removal-recovery', () => ({
  recoverLocalWindowsWorktreeRemoval: vi.fn(async () => undefined)
}))
vi.mock('../local-orphaned-worktree-cleanup', () => ({
  cleanupLocalOrphanedWorktreeDirectory: vi.fn(async () => undefined)
}))

const featureRow = {
  path: '/workspace/feature-wt',
  head: 'abc123',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false
}
const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
const target = { id: 'repo-1::/workspace/feature-wt', repoId: 'repo-1', path: featureRow.path }
// Git dropped the registration, then failed deleting the folder.
const PARTIAL_FAILURE = "error: failed to delete '/workspace/feature-wt': Permission denied"

let events: string[]
let unregister: () => void

function sharedArgs() {
  return {
    repo,
    target,
    registeredWorktree: featureRow,
    removedPushTarget: undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store only reaches the push-target cleanup, which is mocked.
    store: {} as RuntimeStore,
    force: true,
    runHooks: false,
    allowFailedArchiveHook: false,
    allowUnverifiedPtyStop: false,
    deleteBranch: true,
    stopPtys: vi.fn(async () => undefined),
    preserveBranchHead: vi.fn((result: RemoveWorktreeResult | undefined) => result ?? {}),
    finishRemoval: vi.fn()
  }
}

function watcherGate() {
  return vi.fn(async () => ({
    finish: vi.fn(async (removed: boolean) => {
      events.push(`gate finished (removed: ${removed})`)
    })
  }))
}

beforeEach(() => {
  events = []
  unregister = registerWorktreeChangeInvalidator((repoId) => events.push(`invalidated ${repoId}`))
})

afterEach(() => {
  unregister()
  vi.clearAllMocks()
})

describe('runtime removal that fails after git ran', () => {
  it('clears the listing cache for a local project', async () => {
    removeWorktreeMock.mockRejectedValue(new Error(PARTIAL_FAILURE))

    await expect(
      removeRuntimeRegisteredLocalWorktree({
        ...sharedArgs(),
        localOptions: {},
        hasLocalOptions: false,
        acquireWatcherRemoval: watcherGate(),
        closeWatchers: vi.fn(async () => undefined)
      })
    ).rejects.toThrow('Permission denied')

    expect(events).toEqual(['invalidated repo-1', 'gate finished (removed: false)'])
  })

  it('clears the listing cache for an SSH project', async () => {
    const provider = {
      removeWorktree: vi.fn(async () => {
        throw new Error(PARTIAL_FAILURE)
      })
    }

    await expect(
      removeRuntimeRegisteredRemoteWorktree({
        ...sharedArgs(),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal calls only removeWorktree on the provider before it throws.
        provider: provider as unknown as SshGitProvider,
        connectionId: 'conn-1',
        acquireWatcherRemoval: watcherGate(),
        deleteHistory: vi.fn(async () => undefined)
      })
    ).rejects.toThrow('Permission denied')

    expect(events).toEqual(['invalidated repo-1', 'gate finished (removed: false)'])
  })
})
