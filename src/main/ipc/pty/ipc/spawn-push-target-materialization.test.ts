import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Store } from '../../../persistence'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const { triggerMock } = vi.hoisted(() => ({ triggerMock: vi.fn() }))
vi.mock('../../../runtime/runtime-terminal-spawn-push-target-materialization', () => ({
  triggerTerminalSpawnPushTargetMaterialization: triggerMock
}))

import { triggerPtySpawnPushTargetMaterialization } from './spawn-push-target-materialization'

const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/repo/worktree'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const FORK_TARGET: GitPushTarget = {
  remoteName: 'pr-contributor-orca',
  branchName: 'contributor/fix',
  remoteUrl: 'git@github.com:contributor/orca.git'
}
const REPO = { id: REPO_ID, path: '/repo', connectionId: null } as unknown as Repo

function depsWithStore(overrides: Partial<Store> = {}): PtySpawnIpcDeps {
  return {
    store: {
      getWorktreeMeta: vi.fn().mockReturnValue({ pushTarget: FORK_TARGET } as WorktreeMeta),
      getRepo: vi.fn().mockReturnValue(REPO),
      ...overrides
    } as unknown as Store
  } as unknown as PtySpawnIpcDeps
}

function baseArgs(overrides: Partial<PtySpawnIpcArgs> = {}): PtySpawnIpcArgs {
  return { cols: 80, rows: 24, worktreeId: WORKTREE_ID, ...overrides }
}

describe('triggerPtySpawnPushTargetMaterialization', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    triggerMock.mockReset()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('is a no-op when args has no worktreeId', () => {
    triggerPtySpawnPushTargetMaterialization(depsWithStore(), baseArgs({ worktreeId: undefined }))
    expect(triggerMock).not.toHaveBeenCalled()
  })

  it('is a no-op when deps has no store', () => {
    triggerPtySpawnPushTargetMaterialization({} as unknown as PtySpawnIpcDeps, baseArgs())
    expect(triggerMock).not.toHaveBeenCalled()
  })

  it('is a no-op for a malformed worktreeId (no separator)', () => {
    triggerPtySpawnPushTargetMaterialization(
      depsWithStore(),
      baseArgs({ worktreeId: 'not-a-valid-id' })
    )
    expect(triggerMock).not.toHaveBeenCalled()
  })

  it('parses the worktreeId, looks up the push target and repo, and delegates', () => {
    const deps = depsWithStore()
    triggerPtySpawnPushTargetMaterialization(deps, baseArgs())

    expect(deps.store!.getWorktreeMeta).toHaveBeenCalledWith(WORKTREE_ID)
    expect(deps.store!.getRepo).toHaveBeenCalledWith(REPO_ID)
    expect(triggerMock).toHaveBeenCalledWith(
      WORKTREE_PATH,
      FORK_TARGET,
      REPO,
      deps.store,
      REPO_ID,
      WORKTREE_ID
    )
  })

  it('passes null when the repo lookup misses', () => {
    const deps = depsWithStore({ getRepo: vi.fn().mockReturnValue(undefined) })
    triggerPtySpawnPushTargetMaterialization(deps, baseArgs())

    expect(triggerMock).toHaveBeenCalledWith(
      WORKTREE_PATH,
      FORK_TARGET,
      null,
      deps.store,
      REPO_ID,
      WORKTREE_ID
    )
  })

  // Why: many pty:spawn unit tests supply a narrow fake Store missing these methods --
  // this is the actual bug the hook must guard against (#17828), not a hypothetical.
  // Optional chaining degrades the lookups to undefined/null; the underlying trigger
  // itself no-ops on an undefined push target, so this never blocks or throws on spawn.
  it('does not throw when the store lacks getWorktreeMeta/getRepo, delegating with undefined/null', () => {
    const partialStore = {} as Store
    expect(() =>
      triggerPtySpawnPushTargetMaterialization(
        { store: partialStore } as unknown as PtySpawnIpcDeps,
        baseArgs()
      )
    ).not.toThrow()
    expect(triggerMock).toHaveBeenCalledWith(
      WORKTREE_PATH,
      undefined,
      null,
      partialStore,
      REPO_ID,
      WORKTREE_ID
    )
  })

  it('warns and swallows an error thrown by the underlying trigger', () => {
    triggerMock.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() =>
      triggerPtySpawnPushTargetMaterialization(depsWithStore(), baseArgs())
    ).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to trigger push target materialization'),
      expect.any(Error)
    )
  })

  it('strips a folder-workspace instance suffix from the worktree path before delegating', () => {
    const instanceId = 'a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789'
    const deps = depsWithStore()
    const suffixedId = `${WORKTREE_ID}::workspace:${instanceId}`
    triggerPtySpawnPushTargetMaterialization(deps, baseArgs({ worktreeId: suffixedId }))

    expect(triggerMock).toHaveBeenCalledWith(
      WORKTREE_PATH,
      FORK_TARGET,
      REPO,
      deps.store,
      REPO_ID,
      suffixedId
    )
  })
})
