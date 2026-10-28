import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { tryAcquireConditionalWorktreeRemoval } from '../ipc/conditional-worktree-removal-lease'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import { setWorktreeMetaForHost } from '../persistence/loading-store/worktree-identity-metadata'

vi.mock('../worktree-removal-safety', () => ({
  stripOrcaProvenanceMetaUpdates: (updates: unknown) => updates
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-scope-guard', () => ({
  isWslMoveSourceHost: () => false,
  isWslMoveWorkspaceBlocked: () => false,
  shouldDropWslMoveProjectUpdate: () => false,
  wslMoveProjectRefForWorkspace: () => ({ repoId: 'repo' })
}))
vi.mock('./runtime-worktree-lineage-resolution', () => ({
  RuntimeLineageError: class extends Error {}
}))
const mocks = vi.hoisted(() => ({ scheduleSave: vi.fn() }))
vi.mock('../persistence/loading-store/write-scheduling', () => ({
  scheduleSave: mocks.scheduleSave
}))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pin-admission-'))
  vi.resetAllMocks()
})
afterEach(() => rm(root, { recursive: true, force: true }))

function assertIdle(): void {
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Expected released metadata admission')
  }
  admission.release()
}

function fixture() {
  const id = `repo::${root}`
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: metadata mutation reads only this resolved identity; unrelated Git fields are unused.
  const worktree = {
    id,
    repoId: 'repo',
    path: root,
    hostId: 'local',
    instanceId: 'instance'
  } as ResolvedWorktree
  const setWorktreeMeta = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater accesses these metadata ports only; no full runtime is started.
  const store = { getRepos: () => [], setWorktreeMeta } as unknown as RuntimeStore
  const ports = {
    resolveWorktree: vi.fn(async () => worktree),
    showWorktree: vi.fn(async () => worktree),
    validateParent: vi.fn(),
    invalidateResolved: vi.fn(),
    invalidateScan: vi.fn(),
    notifyChanged: vi.fn()
  }
  const update = () =>
    updateRuntimeManagedWorktreeMetadata({
      selector: `id:${id}`,
      updates: { isPinned: true },
      store,
      ports
    })
  return { id, worktree, setWorktreeMeta, ports, update }
}

it('refuses new runtime pin updates before asynchronous selector resolution during closing', async () => {
  const f = fixture()
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Expected closing admission')
  }
  try {
    await expect(f.update()).rejects.toMatchObject({
      code: 'conditional_worktree_removal_in_progress'
    })
    expect(f.ports.resolveWorktree).not.toHaveBeenCalled()
    expect(f.setWorktreeMeta).not.toHaveBeenCalled()
  } finally {
    admission.release()
  }
})

it('holds earlier pin updates across target resolution and result publication', async () => {
  const f = fixture()
  let resolveTarget: ((worktree: ResolvedWorktree) => void) | undefined
  let resolveResult: ((worktree: ResolvedWorktree) => void) | undefined
  f.ports.resolveWorktree.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveTarget = resolve
    })
  )
  f.ports.showWorktree.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveResult = resolve
    })
  )
  const pending = f.update()
  expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
  resolveTarget?.(f.worktree)
  await vi.waitFor(() =>
    expect(f.setWorktreeMeta).toHaveBeenCalledWith(
      { id: f.id, hostId: 'local' },
      { isPinned: true }
    )
  )
  expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
  resolveResult?.(f.worktree)
  await pending
  assertIdle()
})

it('preserves ordinary pin updates and releases admission after resolver or store failure', async () => {
  const f = fixture()
  await f.update()
  expect(f.setWorktreeMeta).toHaveBeenCalledOnce()
  assertIdle()
  f.ports.resolveWorktree.mockRejectedValueOnce(new Error('selector failed'))
  await expect(f.update()).rejects.toThrow('selector failed')
  assertIdle()
  f.setWorktreeMeta.mockImplementationOnce(() => {
    throw new Error('store failed')
  })
  await expect(f.update()).rejects.toThrow('store failed')
  assertIdle()
})

it('guards direct synchronous metadata writes before state access or migration', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this setter uses only the metadata maps; unrelated persisted state is not accessed.
  const runtime = { state: { worktreeMeta: {} } } as Parameters<typeof setWorktreeMetaForHost>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scheduleSave is mocked; the setter never reads a scheduling owner directly.
  const scheduling = {} as Parameters<typeof setWorktreeMetaForHost>[1]
  const id = `repo::${root}`
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Expected closing admission')
  }
  try {
    expect(() =>
      setWorktreeMetaForHost(runtime, scheduling, id, 'local', { isPinned: true })
    ).toThrow('removal is in progress')
    expect(runtime.state.worktreeMeta).toEqual({})
    expect(runtime.state.worktreeMetaByIdentity).toBeUndefined()
    expect(mocks.scheduleSave).not.toHaveBeenCalled()
  } finally {
    admission.release()
  }
  mocks.scheduleSave.mockImplementationOnce(() => {
    expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
  })
  expect(
    setWorktreeMetaForHost(runtime, scheduling, id, 'local', { isPinned: true }).isPinned
  ).toBe(true)
  expect(mocks.scheduleSave).toHaveBeenCalledOnce()
  assertIdle()
  mocks.scheduleSave.mockImplementationOnce(() => {
    throw new Error('save failed')
  })
  expect(() =>
    setWorktreeMetaForHost(runtime, scheduling, id, 'local', { isPinned: false })
  ).toThrow('save failed')
  assertIdle()
})
