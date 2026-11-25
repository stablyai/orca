import { mkdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as lineageUncertainty from '../../../../shared/worktree/lineage/lineage-uncertainty'
import { checkWorkspacePullRequests } from '../../../../shared/orchestration/workspace-pr-check'
import Database from '../../../sqlite/sync-database'
import {
  createWorkerBackedStore,
  lostAcknowledgementWorker,
  writerBarrier
} from './folder-lineage-uncertainty-fixture'
import { profileStateWriterFailureOutcome } from '../../profile-state/writer/profile-state-writer-errors'
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
  release: (store: Store, child: string) => unknown
  edge: (saved: Record<string, Record<string, unknown> | undefined>, key: string) => unknown
  capture: 'preserveFolderLineageUncertainty' | 'markLineageUncertainty'
}

const childStoreLink = (store: Store, child: string) =>
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
  )

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
    seed: childStoreLink,
    release: (store) =>
      store.removeCrossStoreWorkspaceLineage(
        ({ parent }) => parent.workspaceKey === HOME && parent.installationId === 'home-store',
        keep
      ),
    edge: (saved, key) => saved.crossStoreLineageByChildKey?.[key],
    capture: 'markLineageUncertainty'
  },
  {
    // The ordinary `worktree.set --no-parent` removal (runtime-managed-worktree-metadata.ts).
    name: 'child-store detach',
    seed: childStoreLink,
    release: (store, child) =>
      store.removeWorktreeLineage(hostWorktreeTarget({ id: child, hostId: 'local' })),
    edge: (saved, key) => saved.crossStoreLineageByChildKey?.[key],
    capture: 'preserveFolderLineageUncertainty'
  }
]

async function seed(variant: Variant, worker?: (directory: string) => { workerPath: string }) {
  const h = await createWorkerBackedStore({ worker })
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
  return { ...h, child, key, liveCheck, marker: JSON.stringify(['local', key]) }
}

type Saved = Record<string, Record<string, unknown> | undefined>
const domainsOf = (domains: readonly { domain: string; payload: string | null }[]): Saved =>
  Object.fromEntries(domains.map(({ domain, payload }) => [domain, JSON.parse(payload ?? 'null')]))

describe.each(variants)('$name through the actual async profile writer', (v) => {
  it('an older write that captured the same lineage domains commits the old edge; the release then commits marker and erasure together', async () => {
    const h = await seed(v)
    const gates = [0, 1].map(() => ({ entered: writerBarrier(), release: writerBarrier() }))
    const batches: Saved[] = []
    const original = h.authority.writeSerializedDomains.bind(h.authority)
    const spy = vi.spyOn(h.authority, 'writeSerializedDomains')
    for (const gate of gates) {
      spy.mockImplementationOnce(async (domains) => {
        batches.push(domainsOf(domains))
        gate.entered.resolve()
        await gate.release.promise
        await original(domains)
      })
    }
    // An unrelated lineage write: its save serializes every lineage domain, the edge included.
    h.store.setWorkspaceLineage({
      childWorkspaceKey: 'worktree:p::/elsewhere/unrelated',
      childInstanceId: 'unrelated',
      parentWorkspaceKey: 'worktree:p::/elsewhere/parent',
      parentInstanceId: 'parent',
      origin: 'cli',
      capture,
      createdAt: 1
    })
    // Flushing waits for every pending write, the release's too, so it settles only at the end.
    const flushed = h.store.flushPendingOrThrowAsync()
    await gates[0]!.entered.promise
    // The held snapshot already holds this child's edge and no marker for it.
    expect(v.edge(batches[0]!, h.key)).toBeDefined()
    expect(batches[0]!.workspaceLineageUncertaintyByChild?.[h.marker]).toBeUndefined()
    v.release(h.store, h.child)
    expect(h.liveCheck()).toBe('partial')
    gates[0]!.release.resolve()
    // The release's write starts only once the older one committed.
    await gates[1]!.entered.promise
    expect(v.edge(batches[1]!, h.key)).toBeUndefined()
    expect(batches[1]!.workspaceLineageUncertaintyByChild?.[h.marker]).toBe(true)
    // Between the two commits the database holds the old edge: still evidence of the folder parent.
    let saved = h.readState()
    expect(v.edge(saved, h.key)).toBeDefined()
    expect(saved.workspaceLineageUncertaintyByChild?.[h.marker]).toBeUndefined()
    expect(h.store.getWorkspaceLineageUncertainty()[h.marker]).toBe(true)
    expect(h.liveCheck()).toBe('partial')
    gates[1]!.release.resolve()
    await flushed
    saved = h.readState()
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
      v.release(h.store, h.child)
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

  it('keeps the committed marker when the Store-facing call throws after commit', async () => {
    const h = await seed(v)
    const original = h.authority.writeSerializedDomains.bind(h.authority)
    vi.spyOn(h.authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      await original(domains)
      throw new Error('lost acknowledgement')
    })
    v.release(h.store, h.child)
    await expect(h.store.flushPendingOrThrowAsync()).rejects.toThrow()
    const saved = h.readState()
    expect(v.edge(saved, h.key)).toBeUndefined()
    expect(saved.workspaceLineageUncertaintyByChild[h.marker]).toBe(true)
    expect(h.liveCheck()).toBe('partial')
  })

  it('keeps marker custody when the writer worker dies after commit, before it replies', async () => {
    let worker: ReturnType<typeof lostAcknowledgementWorker> | undefined
    const h = await seed(v, (directory) => (worker = lostAcknowledgementWorker(directory)))
    worker!.arm()
    v.release(h.store, h.child)
    const failure = await h.store.flushPendingOrThrowAsync().catch((error: unknown) => error)
    // The Store cannot tell whether the write landed: that is the uncertain acknowledgement.
    expect(profileStateWriterFailureOutcome(failure)).toBe('indeterminate')
    expect(worker!.armed()).toBe(false)
    const saved = h.readState()
    expect(v.edge(saved, h.key)).toBeUndefined()
    expect(saved.workspaceLineageUncertaintyByChild?.[h.marker]).toBe(true)
    expect(h.store.getWorkspaceLineageUncertainty()[h.marker]).toBe(true)
    expect(h.liveCheck()).toBe('partial')
  })

  it('keeps the old edge, live and durable, when capture fails before erasure', async () => {
    const h = await seed(v)
    vi.spyOn(lineageUncertainty, v.capture).mockImplementationOnce(() => {
      throw new Error('capture interrupted')
    })
    expect(() => v.release(h.store, h.child)).toThrow('capture interrupted')
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
