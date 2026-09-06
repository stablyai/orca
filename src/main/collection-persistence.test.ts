import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import type { PersistedState } from '../shared/persisted-state-types'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import {
  createStore,
  makeRepo,
  readDataFile as readDataFileUntyped,
  testState,
  writeDataFile
} from './persistence-test-harness'

function readDataFile(): PersistedState {
  return readDataFileUntyped() as PersistedState
}

describe('Store collections', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-collections-test-'))
    // Why: load sweeps worktree rows owned by a deregistered repo (#17776), so
    // membership only survives a reload when its repo is actually registered.
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: 'repo-api', path: '/repo-api' })],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} }
    })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('creates collections with appended order and lists them sorted', async () => {
    const store = await createStore()
    const approvals = store.createCollection({ name: '  Approve PRs ' })
    const billing = store.createCollection({ name: 'Billing migration' })
    expect(approvals.name).toBe('Approve PRs')
    expect(approvals.order).toBe(0)
    expect(billing.order).toBe(1)
    expect(store.getCollections().map((collection) => collection.id)).toEqual([
      approvals.id,
      billing.id
    ])
  })

  it('updates name, color, collapse, and order', async () => {
    const store = await createStore()
    const collection = store.createCollection({ name: 'Approve PRs' })
    const updated = store.updateCollection(collection.id, {
      name: 'Approvals',
      color: '#ff0000',
      isCollapsed: true,
      order: 5
    })
    expect(updated).toMatchObject({
      name: 'Approvals',
      color: '#ff0000',
      isCollapsed: true,
      order: 5
    })
    expect(store.updateCollection('missing', { name: 'x' })).toBeNull()
    // Blank rename keeps the current name rather than falling back to Untitled.
    expect(store.updateCollection(collection.id, { name: '   ' })?.name).toBe('Approvals')
  })

  it('sets worktree membership with dedupe and unknown-id pruning', async () => {
    const store = await createStore()
    const approvals = store.createCollection({ name: 'Approve PRs' })
    const meta = store.setWorktreeCollectionIds('repo-api::/wt/ptal', [
      approvals.id,
      approvals.id,
      'not-a-collection'
    ])
    expect(meta.collectionIds).toEqual([approvals.id])
  })

  it('clears membership to undefined, never []', async () => {
    const store = await createStore()
    const approvals = store.createCollection({ name: 'Approve PRs' })
    store.setWorktreeCollectionIds('repo-api::/wt/ptal', [approvals.id])
    const cleared = store.setWorktreeCollectionIds('repo-api::/wt/ptal', [])
    expect(cleared.collectionIds).toBeUndefined()
    expect('collectionIds' in cleared).toBe(false)
  })

  it('supports the same worktree in several collections and survives reload', async () => {
    const store = await createStore()
    const approvals = store.createCollection({ name: 'Approve PRs' })
    const billing = store.createCollection({ name: 'Billing migration' })
    store.setWorktreeCollectionIds('repo-api::/wt/shared', [approvals.id, billing.id])
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getCollections()).toHaveLength(2)
    expect(reloaded.getWorktreeMeta('repo-api::/wt/shared')?.collectionIds).toEqual([
      approvals.id,
      billing.id
    ])
  })

  it('deleting a collection strips memberships but keeps other collections', async () => {
    const store = await createStore()
    const approvals = store.createCollection({ name: 'Approve PRs' })
    const billing = store.createCollection({ name: 'Billing migration' })
    store.setWorktreeCollectionIds('repo-api::/wt/both', [approvals.id, billing.id])
    store.setWorktreeCollectionIds('repo-api::/wt/only-approvals', [approvals.id])

    expect(store.deleteCollection(approvals.id)).toBe(true)
    expect(store.deleteCollection(approvals.id)).toBe(false)
    expect(store.getWorktreeMeta('repo-api::/wt/both')?.collectionIds).toEqual([billing.id])
    const orphan = store.getWorktreeMeta('repo-api::/wt/only-approvals')
    expect(orphan?.collectionIds).toBeUndefined()
  })

  it('prunes dangling membership ids on load', async () => {
    const store = await createStore()
    const approvals = store.createCollection({ name: 'Approve PRs' })
    store.setWorktreeCollectionIds('repo-api::/wt/ptal', [approvals.id])
    store.flush()

    const raw = readDataFile()
    raw.worktreeMeta['repo-api::/wt/ptal'].collectionIds = [approvals.id, 'deleted-elsewhere']
    writeDataFile(raw)

    const reloaded = await createStore()
    expect(reloaded.getWorktreeMeta('repo-api::/wt/ptal')?.collectionIds).toEqual([approvals.id])
  })

  it('removes an on-disk empty membership array on load', async () => {
    const store = await createStore()
    const approvals = store.createCollection({ name: 'Approve PRs' })
    store.setWorktreeCollectionIds('repo-api::/wt/ptal', [approvals.id])
    store.flush()

    const raw = readDataFile()
    raw.worktreeMeta['repo-api::/wt/ptal'].collectionIds = []
    writeDataFile(raw)

    const reloaded = await createStore()
    expect(reloaded.getWorktreeMeta('repo-api::/wt/ptal')?.collectionIds).toBeUndefined()
    reloaded.flush()
    expect('collectionIds' in readDataFile().worktreeMeta['repo-api::/wt/ptal']).toBe(false)
  })

  it('loads pre-collection data files without changes', async () => {
    const store = await createStore()
    store.createCollection({ name: 'temp' })
    store.flush()
    const raw = readDataFile() as Record<string, unknown>
    delete raw.collections
    writeDataFile(raw)

    const reloaded = await createStore()
    expect(reloaded.getCollections()).toEqual([])
  })
})

describe('mergeWorktree collection threading', () => {
  const git: GitWorktreeInfo = {
    path: '/wt/ptal',
    head: 'abc123',
    branch: 'refs/heads/ptal-age-only',
    isBare: false,
    isMainWorktree: false
  }

  it('carries meta.collectionIds onto the merged worktree', () => {
    const merged = mergeWorktree('repo-api', git, {
      displayName: 'ptal',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      collectionIds: ['c1', 'c2']
    })
    expect(merged.collectionIds).toEqual(['c1', 'c2'])
  })

  it('omits the key entirely when meta has none', () => {
    const merged = mergeWorktree('repo-api', git, undefined)
    expect('collectionIds' in merged).toBe(false)
  })
})
