import { mkdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as lineageUncertainty from '../../../../shared/worktree/lineage/lineage-uncertainty'
import { checkWorkspacePullRequests } from '../../../../shared/orchestration/workspace-pr-check'
import Database from '../../../sqlite/sync-database'
import { createWorkerBackedStore, writerBarrier } from './folder-lineage-uncertainty-fixture'
import { makeRepo } from '../../persistence-test-harness'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import type { Store } from '../store'

const HOME = folderWorkspaceKey('deleted-bot-home')
const capture = {
  source: 'explicit-cli-flag',
  confidence: 'explicit'
} as const
// The same removal and option the bot-home release RPC uses (workspace-metadata.ts releaseBotHome).
const keep = { keepFolderUncertainty: true }

type Variant = {
  name: string
  seed: (store: Store, child: string) => void
  release: (store: Store) => unknown[]
  edge: (saved: Record<string, Record<string, unknown> | undefined>, key: string) => unknown
  capture: 'preserveFolderLineageUncertainty' | 'markLineageUncertainty'
}

const variants: Variant[] = [
  {
    name: 'same-store',
    seed: (store, child) =>
      store.setFolderParentLineage(hostWorktreeTarget({ id: child, hostId: 'local' }), {
        childWorkspaceKey: worktreeWorkspaceKey(child),
        childInstanceId: 'child-instance',
        parentWorkspaceKey: HOME,
        parentInstanceId: 'deleted-bot-home',
        origin: 'cli',
        capture,
        createdAt: 1
      }),
    release: (store) =>
      store.removeWorkspaceLineage((row) => row.parentWorkspaceKey === HOME, keep),
    edge: (saved, key) => saved.workspaceLineageByChildKey?.[key],
    capture: 'preserveFolderLineageUncertainty'
  },
  {
    name: 'child-store',
    seed: (store, child) =>
      store.setCrossStoreWorkspaceLineage(
        {
          childWorkspaceKey: worktreeWorkspaceKey(child),
          childInstanceId: 'child-instance',
          parent: {
            installationId: 'home-store',
            workspaceKey: HOME,
            instanceId: 'home'
          },
          origin: 'cli',
          capture,
          createdAt: 1
        },
        'local'
      ),
    release: (store) =>
      store.removeCrossStoreWorkspaceLineage(
        ({ parent }) => parent.workspaceKey === HOME && parent.installationId === 'home-store',
        keep
      ),
    edge: (saved, key) => saved.crossStoreLineageByChildKey?.[key],
    capture: 'markLineageUncertainty'
  }
]

async function seed(variant: Variant) {
  const h = await createWorkerBackedStore()
  const identity = (id: string) => ({
    canonicalKey: `github.com/org/${id}`,
    remoteName: 'origin',
    remoteUrl: ''
  })
  mkdirSync(`${h.directory}/p`, { recursive: true })
  mkdirSync(`${h.directory}/q/child`, { recursive: true })
  h.store.addRepo(
    makeRepo({
      id: 'p',
      path: `${h.directory}/p`,
      gitRemoteIdentity: identity('p')
    })
  )
  h.store.addRepo(
    makeRepo({
      id: 'q',
      path: `${h.directory}/q`,
      gitRemoteIdentity: identity('q')
    })
  )
  const child = `q::${h.directory}/q/child`
  h.store.setWorktreeMeta(hostWorktreeTarget({ id: child, hostId: 'local' }), {
    instanceId: 'child-instance',
    createdAt: 1
  })
  variant.seed(h.store, child)
  await h.store.flushPendingOrThrowAsync()
  const key = worktreeWorkspaceKey(child)
  // What a fresh P completion reporting Q#17 sees in the running Store.
  const liveCheck = () =>
    checkWorkspacePullRequests(
      {
        repos: h.store.getRepos(),
        metadata: (id, host) => {
          const meta = h.store.getWorktreeMetaForHost(id, 'local', {
            migrate: false
          })
          return meta?.hostId === host ? meta : undefined
        },
        lineage: h.store.getAllWorktreeLineage(),
        workspaceLineage: h.store.getAllWorkspaceLineage(),
        crossStoreLineage: h.store.getRawCrossStoreWorkspaceLineage(),
        childIndex: (limit) => h.store.getLineageChildIndex(limit),
        uncertainty: h.store.getWorkspaceLineageUncertainty(),
        folders: [],
        primaries: [`p::${h.directory}/p`]
      },
      { subject: 'Opened org/q#17', body: '', spec: '', host: 'local' }
    ).state
  return { ...h, key, liveCheck, marker: JSON.stringify(['local', key]) }
}

describe.each(variants)('$name bot-home release through the actual async profile writer', (v) => {
  it('commits the marker and the erasure in one snapshot, after an older queued write', async () => {
    const h = await seed(v)
    const entered = writerBarrier(),
      release = writerBarrier()
    const original = h.authority.writeSerializedDomains.bind(h.authority)
    vi.spyOn(h.authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      entered.resolve()
      await release.promise
      await original(domains)
    })
    h.store.addRepo(makeRepo({ id: 'r', path: `${h.directory}/r` }))
    const oldWrite = h.store.flushPendingOrThrowAsync()
    await entered.promise
    expect(v.release(h.store)).toEqual([h.key])
    expect(h.liveCheck()).toBe('partial')
    expect(v.edge(h.readState(), h.key)).toBeDefined()
    release.resolve()
    await oldWrite
    await h.store.flushPendingOrThrowAsync()
    const saved = h.readState()
    expect(v.edge(saved, h.key)).toBeUndefined()
    expect(saved.workspaceLineageUncertaintyByChild).toEqual({
      [h.marker]: true
    })
  })

  it('rolls back the erasure when the marker write fails inside SQLite, and the running check still remembers', async () => {
    const h = await seed(v)
    const fault = new Database(h.databaseFile)
    for (const op of ['INSERT', 'UPDATE']) {
      fault.exec(
        `CREATE TRIGGER reject_marker_${op} BEFORE ${op} ON profile_state_documents WHEN NEW.domain = 'workspaceLineageUncertaintyByChild' BEGIN SELECT RAISE(ABORT, 'uncertainty write failure'); END`
      )
    }
    try {
      v.release(h.store)
      await expect(h.store.flushPendingOrThrowAsync()).rejects.toThrow()
      const saved = h.readState()
      expect(v.edge(saved, h.key)).toBeDefined()
      expect(saved.workspaceLineageUncertaintyByChild?.[h.marker]).toBeUndefined()
      expect(h.store.getWorkspaceLineageUncertainty()[h.marker]).toBe(true)
      expect(h.liveCheck()).toBe('partial')
    } finally {
      fault.exec('DROP TRIGGER reject_marker_INSERT')
      fault.exec('DROP TRIGGER reject_marker_UPDATE')
      fault.close()
    }
  })

  it('keeps the committed marker when acknowledgement is lost after commit', async () => {
    const h = await seed(v)
    const original = h.authority.writeSerializedDomains.bind(h.authority)
    vi.spyOn(h.authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      await original(domains)
      throw new Error('lost acknowledgement')
    })
    v.release(h.store)
    await expect(h.store.flushPendingOrThrowAsync()).rejects.toThrow()
    const saved = h.readState()
    expect(v.edge(saved, h.key)).toBeUndefined()
    expect(saved.workspaceLineageUncertaintyByChild[h.marker]).toBe(true)
    expect(h.liveCheck()).toBe('partial')
  })

  it('keeps the old edge, live and durable, when capture fails before erasure', async () => {
    const h = await seed(v)
    vi.spyOn(lineageUncertainty, v.capture).mockImplementationOnce(() => {
      throw new Error('capture interrupted')
    })
    expect(() => v.release(h.store)).toThrow('capture interrupted')
    expect(
      v.edge(
        {
          workspaceLineageByChildKey: h.store.getAllWorkspaceLineage(),
          crossStoreLineageByChildKey: h.store.getRawCrossStoreWorkspaceLineage()
        },
        h.key
      )
    ).toBeDefined()
    expect(h.liveCheck()).toBe('partial')
    await h.store.flushPendingOrThrowAsync()
    expect(v.edge(h.readState(), h.key)).toBeDefined()
  })
})
