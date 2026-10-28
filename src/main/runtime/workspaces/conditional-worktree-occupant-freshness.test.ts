import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithConditionalWorktreeRemoval } from './workspace-conditional-removal'
import { RuntimeWorkspaceSelectors } from './workspace-selectors'
import { RuntimeResolvedWorktreeCache } from '../runtime-resolved-worktree-cache'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { setWorktreeMetaForHost } from '../../persistence/loading-store/worktree-identity-metadata'
import { tryAcquireConditionalWorktreeRemoval } from '../../ipc/conditional-worktree-removal-lease'
import type { ConditionalWorktreeRemovalRequest } from '../../../shared/rpc-contract/conditional-worktree-removal'
import type { removeConditionalWorktree } from './conditional-worktree-removal'

type Occupant = 'same' | 'absent' | 'changed'
const mocks = vi.hoisted(() => ({ remove: vi.fn(), occupants: new Array<Occupant>() }))
vi.mock('./workspace-metadata', () => ({ OrcaRuntimeWithCreateManagedRemoteWorktree: class {} }))
vi.mock('../terminal/launch/terminal-workspace-scope', () => ({
  OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree: class {}
}))
vi.mock('../../hooks', () => ({ getEffectiveHooks: () => undefined }))
vi.mock('../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { store: { readOnly: false } } })
}))
vi.mock('../../git/runner', () => ({}))
vi.mock('../../ipc/worktree-metadata-merge', () => ({ mergeWorktree: vi.fn() }))
vi.mock('./conditional-worktree-removal', () => ({ removeConditionalWorktree: mocks.remove }))
vi.mock('../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: () => {} }))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-occupant-freshness-'))
  mocks.occupants.length = 0
  mocks.remove.mockImplementation(
    async (
      request: ConditionalWorktreeRemovalRequest,
      deps: Parameters<typeof removeConditionalWorktree>[1]
    ) => {
      const admission = tryAcquireConditionalWorktreeRemoval(request.expected.checkout.path)
      if (admission.kind !== 'acquired') {
        throw new Error('Expected idle admission')
      }
      try {
        const occupant = await deps.verifyOccupant()
        mocks.occupants.push(occupant)
        return {
          status: 'refused',
          reason: occupant === 'same' ? 'outcome_unknown' : 'identity_changed',
          detail: 'No deletion in fixture'
        }
      } finally {
        admission.release()
      }
    }
  )
})
afterEach(() => rm(root, { recursive: true, force: true }))

function fixture() {
  const id = `repo::${root}`
  const physical = { path: root, device: '1', inode: '1' }
  const request: ConditionalWorktreeRemovalRequest = {
    requestId: '00000000-0000-4000-8000-000000000001',
    expected: {
      repoId: 'repo',
      worktreeId: id,
      executionHostId: 'local',
      instanceId: 'instance',
      identityKey: 'identity',
      branch: 'refs/heads/topic',
      head: 'a'.repeat(40),
      checkout: physical,
      commonGitDirectory: physical,
      adminDirectory: physical
    }
  }
  const git = {
    path: root,
    head: request.expected.head,
    branch: request.expected.branch,
    isBare: false,
    isMainWorktree: false
  }
  const row: ResolvedWorktree = {
    ...git,
    git,
    id,
    repoId: 'repo',
    hostId: 'local',
    instanceId: 'instance',
    identity: { key: 'identity', executionHostId: 'local', instanceId: 'instance' },
    isPinned: false,
    childWorktreeIds: [],
    parentWorktreeId: null,
    lineage: null,
    displayName: 'topic',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real setter reads only metadata maps; other persisted state is not used.
  const metadata = {
    state: { worktreeMeta: { [id]: { hostId: 'local', instanceId: 'instance', isPinned: false } } }
  } as Parameters<typeof setWorktreeMetaForHost>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scheduleSave is mocked and never reads this scheduling owner.
  const scheduling = {} as Parameters<typeof setWorktreeMetaForHost>[1]
  const pin = () => setWorktreeMetaForHost(metadata, scheduling, id, 'local', { isPinned: true })
  const snapshot = () => ({
    worktrees: [{ ...row, isPinned: metadata.state.worktreeMeta[id]?.isPinned ?? false }],
    platformByRepoId: new Map<string, NodeJS.Platform>()
  })
  const cache = new RuntimeResolvedWorktreeCache()
  const compute = vi.fn(async () => snapshot())
  const read = () => cache.getSnapshot(compute, 60_000, 0)
  const store = {
    getRepos: () => [{ id: 'repo', path: root, executionHostId: 'local' }],
    getProfileStorageDirectory: () => root,
    getWorkspaceSession: () => ({}),
    getWorkspaceSessionHostIds: () => []
  }
  const runtime: OrcaRuntimeWithConditionalWorktreeRemoval = Object.assign(
    Object.create(OrcaRuntimeWithConditionalWorktreeRemoval.prototype),
    {
      store,
      conditionalRemovalUserIsViewing: () => false,
      getValidatedExplicitWorktreeIdSelector: () => id,
      hasFreshResolvedWorktreeCache: () => cache.isFresh(0),
      resolveExplicitWorktreeIdScoped: async () => null,
      invalidateResolvedWorktreeCache: () => cache.invalidateResolved(),
      listResolvedWorktrees: async () => (await read()).worktrees,
      showManagedWorktree: async (selector: string): Promise<ResolvedWorktree> => {
        return RuntimeWorkspaceSelectors.prototype['resolveWorktreeSelector'].call(
          runtime,
          selector
        )
      }
    }
  )
  const verify = () => runtime.removeManagedWorktreeIfIdle(request)
  return { cache, compute, read, pin, snapshot, verify }
}

it('rejects a prior UI pin hidden by a warm resolved snapshot', async () => {
  const f = fixture()
  await f.read()
  expect(f.pin().isPinned).toBe(true)
  expect(f.cache.peek()?.worktrees[0].isPinned).toBe(false)
  await expect(f.verify()).resolves.toMatchObject({ reason: 'identity_changed' })
  expect(mocks.occupants).toEqual(['changed'])
  expect(f.cache.peek()?.worktrees[0].isPinned).toBe(true)
})

it('does not reuse or publish an older in-flight snapshot after a prior pin', async () => {
  const f = fixture()
  const stale = f.snapshot()
  let finish: ((value: typeof stale) => void) | undefined
  const old = f.cache.getSnapshot(
    () =>
      new Promise<typeof stale>((resolve) => {
        finish = resolve
      }),
    60_000,
    0
  )
  f.pin()
  await expect(f.verify()).resolves.toMatchObject({ reason: 'identity_changed' })
  expect(mocks.occupants).toEqual(['changed'])
  expect(f.cache.peek()?.worktrees[0].isPinned).toBe(true)
  finish?.(stale)
  await old
  expect(f.cache.peek()?.worktrees[0].isPinned).toBe(true)
})

it('continues to accept a freshly resolved unpinned occupant', async () => {
  const f = fixture()
  await f.read()
  await f.verify()
  expect(mocks.occupants).toEqual(['same'])
  expect(f.compute).toHaveBeenCalledTimes(2)
})

it('continues to refuse a pin update while closing is active', () => {
  const f = fixture()
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Expected closing admission')
  }
  try {
    expect(f.pin).toThrow('removal is in progress')
  } finally {
    admission.release()
  }
})
