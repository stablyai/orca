import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import type { Store } from '../persistence'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  WslMoveProjectFencedError,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import {
  persistRuntimeManagedWorktreeSortOrder,
  updateRuntimeManagedWorktreeMetadata
} from './runtime-managed-worktree-metadata'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const MOVING = 'repo-1::/src/app'
const STAYING = 'repo-2::/src/other'

function resolved(id: string): ResolvedWorktree {
  const repoId = id.slice(0, id.indexOf('::'))
  const path = id.slice(repoId.length + 2)
  return {
    id,
    repoId,
    instanceId: `${id}#instance`,
    hostId: 'local',
    path,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'app',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path, head: 'abc', branch: 'refs/heads/main', isBare: false, isMainWorktree: false }
  }
}

function ports() {
  return {
    resolveWorktree: vi.fn(async (selector: string) => resolved(selector.replace(/^id:/, ''))),
    validateParent: vi.fn(),
    invalidateResolved: vi.fn(),
    invalidateScan: vi.fn(),
    notifyChanged: vi.fn(),
    showWorktree: vi.fn(async (selector: string) => resolved(selector.replace(/^id:/, '')))
  }
}

let store: Store
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-meta-'))
  store = createStore()
  loadWslMoveFence(testState.dir)
  seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
})
afterEach(async () => {
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('updateRuntimeManagedWorktreeMetadata under a WSL move', () => {
  type Updates = Parameters<typeof updateRuntimeManagedWorktreeMetadata>[0]['updates']
  const update = (selector: string, updates: Updates, p = ports()) =>
    updateRuntimeManagedWorktreeMetadata({ selector: `id:${selector}`, updates, store, ports: p })

  it('drops background bookkeeping quietly and writes nothing', async () => {
    const p = ports()
    const result = await update(MOVING, { isUnread: true, lastActivityAt: 5 }, p)
    expect(result.id).toBe(MOVING)
    expect(store.getWorktreeMeta(MOVING)).toBeUndefined()
    expect(p.notifyChanged).not.toHaveBeenCalled()
  })

  it('refuses a user edit', async () => {
    await expect(update(MOVING, { comment: 'mine' })).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
    expect(store.getWorktreeMeta(MOVING)).toBeUndefined()
  })

  it('refuses a lineage change even alongside passive fields', async () => {
    await expect(
      update(MOVING, { isUnread: true, lineage: { noParent: true } })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
  })

  it('leaves a project the move is not taking untouched', async () => {
    await update(STAYING, { comment: 'mine' })
    expect(store.getWorktreeMeta(STAYING)?.comment).toBe('mine')
  })
})

describe('persistRuntimeManagedWorktreeSortOrder under a WSL move', () => {
  it('drops the moving project from the batch and writes the rest', () => {
    store.setWorktreeMeta(hostWorktreeTarget({ id: MOVING, hostId: 'local' }), { sortOrder: 1 })
    store.setWorktreeMeta(hostWorktreeTarget({ id: STAYING, hostId: 'local' }), { sortOrder: 2 })
    const result = persistRuntimeManagedWorktreeSortOrder({
      orderedIds: [MOVING, STAYING],
      store,
      invalidateResolved: vi.fn(),
      notifyChanged: vi.fn()
    })
    expect(result).toEqual({ updated: 1 })
    expect(store.getWorktreeMeta(MOVING)?.sortOrder).toBe(1)
    expect(store.getWorktreeMeta(STAYING)?.sortOrder).toBeGreaterThan(2)
  })

  // A host-qualified read migrates a legacy row in place, which the move must keep frozen.
  it('never reads the moving copy by host, even when the client names its host', () => {
    store.setWorktreeMeta(hostWorktreeTarget({ id: STAYING, hostId: 'local' }), { sortOrder: 2 })
    const hostRead = vi.spyOn(store, 'getWorktreeMetaForHost')
    persistRuntimeManagedWorktreeSortOrder({
      orderedIds: [MOVING, STAYING],
      hostIds: ['local', 'local'],
      store,
      invalidateResolved: vi.fn(),
      notifyChanged: vi.fn()
    })
    expect(hostRead.mock.calls.map(([id]) => id)).not.toContain(MOVING)
  })
})
