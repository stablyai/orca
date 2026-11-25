// Real Git proves every Add Project writer finds one machine's worktree family whatever a row's host stamp.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'

const metadataGates = vi.hoisted(() => new Map<string, Promise<void>>())
const metadataArrivals = vi.hoisted((): string[] => [])
const ipcHandlers = vi.hoisted(
  () => new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
)
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      void ipcHandlers.set(channel, handler)
  }
}))
vi.mock('../../ipc/repos/repos-changed-notification', () => ({
  notifyReposChanged: () => undefined
}))
vi.mock('../../ipc/repos/repo-added-telemetry', () => ({ emitRepoAdded: () => undefined }))
vi.mock('../../repository-icons/repo-icon-autodetect', () => ({
  detectRepoLocalMetadata: async ({ repoPath }: { repoPath: string }) => {
    metadataArrivals.push(repoPath)
    await metadataGates.get(repoPath)
    return {}
  }
}))
vi.mock('../creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: async () => undefined
}))

import {
  asStore,
  createDesktopNestedImport,
  createScratch,
  createStore,
  createWorktreeFamily,
  createWriters,
  runtimeNestedImport,
  seedRepo
} from './checkout-family-real-git.test-fixture'
import { adoptEndpointRepo } from '../../../shared/project/catalog/endpoint-catalog-adoption'
import {
  findExactRepoOwner,
  hasConflictingStoredWorktreeOwner
} from '../../ipc/worktrees/listing/worktree-host-ownership'
import type { Store } from '../../persistence/loading-store/store'

installRealWorkerThreadChildProcesses()

const desktopNestedImport = createDesktopNestedImport(ipcHandlers)
const writers = createWriters(desktopNestedImport)
function writer(name: string) {
  const found = writers.find(([writerName]) => writerName === name)
  if (!found) {
    throw new Error(`No writer named ${name}`)
  }
  return found[1]
}

let scratchDir = ''
let family: Awaited<ReturnType<typeof createWorktreeFamily>>

function gate(path: string): () => void {
  let open = (): void => undefined
  metadataGates.set(
    path,
    new Promise<void>((resolve) => {
      open = resolve
    })
  )
  return open
}

afterEach(async () => {
  metadataGates.clear()
  metadataArrivals.length = 0
  ipcHandlers.clear()
  await removeTree(scratchDir)
}, 60_000)

describe('a non-bare primary with linked siblings', () => {
  // Real Git fixture setup can exceed the default hook budget on a busy machine.
  beforeEach(async () => {
    scratchDir = await createScratch('orca-family-host-')
    family = await createWorktreeFamily(scratchDir)
  }, 60_000)

  const sshControls: [string, Partial<Repo>][] = [
    ['an ssh: stamp', { executionHostId: 'ssh:box' }],
    ['a legacy SSH connection', { connectionId: 'box' }]
  ]

  describe.each(writers)('%s', (_name, write) => {
    it.each<[string, Partial<Repo>]>([
      ['a client-minted runtime host', { executionHostId: 'runtime:paired-client' }],
      ['the local host', { executionHostId: 'local' }],
      ['no host stamp', {}]
    ])('reuses a sibling project registered with %s', async (_label, owner) => {
      const seeded = seedRepo(family.siblingA, owner)
      const { repos, store } = createStore([seeded])
      expect(await write(store, family.siblingB, family.parentDir)).toBe(seeded.id)
      expect(repos).toHaveLength(1)
    })

    it.each(sshControls)('never adopts an SSH project at the same path (%s)', async (_l, owner) => {
      const ssh = seedRepo(family.siblingA, owner)
      const { repos, store } = createStore([{ ...ssh }])
      const id = await write(store, family.siblingA, family.parentDir)
      expect(id).not.toBe(ssh.id)
      expect(repos).toHaveLength(2)
      expect(repos[0]).toEqual(ssh)
    })
  })

  // A paired client once stamped this machine's row with its own runtime: address.
  describe('a desktop add reusing a row with an unmapped legacy runtime: stamp', () => {
    it('completes on this machine: local route, local owner, legacy metadata kept', async () => {
      const legacy = seedRepo(family.siblingA, { executionHostId: 'runtime:prior-client' })
      const { store } = createStore([legacy])
      const id = await writer('desktop add')(store, family.siblingB, family.parentDir)
      expect(id).toBe(legacy.id)
      // The desktop renderer adopts its own endpoint's row; completion routes by that host.
      expect(adoptEndpointRepo({ kind: 'local' }, legacy).executionHostId).toBe('local')
      // The local listing that completion requests finds this row as its owner.
      const desktopStore = asStore<Store>({
        ...store,
        getWorktreeMeta: () => ({ hostId: 'runtime:prior-client' })
      })
      expect(findExactRepoOwner(desktopStore, id, 'local')).toBe(legacy)
      // Metadata written under the legacy stamp does not read as another owner's.
      expect(
        hasConflictingStoredWorktreeOwner(desktopStore, legacy, [`${id}::${family.siblingB}`])
      ).toBe(false)
    })

    it('keeps a paired server row and an SSH row on their own hosts', () => {
      const paired = seedRepo(family.siblingA)
      expect(
        adoptEndpointRepo({ kind: 'environment', environmentId: 'paired' }, paired).executionHostId
      ).toBe('runtime:paired')
      const ssh = seedRepo(family.siblingA, { executionHostId: 'ssh:box' })
      expect(adoptEndpointRepo({ kind: 'local' }, ssh).executionHostId).toBe('ssh:box')
      const { store } = createStore([ssh])
      expect(findExactRepoOwner(asStore<Store>(store), ssh.id, 'local')).toBeUndefined()
    })
  })

  // Desktop IPC and the runtime share one store on the desktop, so their writers race each other.
  describe.each([
    ['desktop add', 'host setup add'],
    ['desktop nested import', 'runtime add']
  ])('%s racing %s', (firstName, secondName) => {
    it.each([
      ['the first', 0],
      ['the second', 1]
    ])('registers one project when %s finishes first', async (_order, firstIndex) => {
      const ssh = seedRepo(family.siblingA, { executionHostId: 'ssh:box' })
      const { repos, store } = createStore([{ ...ssh }])
      // A nested import reads metadata for the main checkout it imports.
      const gatePaths = [
        firstName.includes('nested') ? family.primaryPath : family.siblingA,
        secondName.includes('nested') ? family.primaryPath : family.siblingB
      ]
      const opens = gatePaths.map(gate)
      const adds = [
        writer(firstName)(store, family.siblingA, family.parentDir),
        writer(secondName)(store, family.siblingB, family.parentDir)
      ]
      // Both adds are now past their pre-metadata checks.
      await vi.waitFor(() => expect(metadataArrivals).toHaveLength(2), { timeout: 30_000 })
      opens[firstIndex]()
      await adds[firstIndex]
      opens[1 - firstIndex]()
      const [a, b] = await Promise.all(adds)
      expect(a).toBe(b)
      expect(repos).toHaveLength(2)
      expect(repos[0]).toEqual(ssh)
    })
  })
})

describe('a bare primary with linked siblings', () => {
  beforeEach(async () => {
    scratchDir = await createScratch('orca-family-bare-')
    family = await createWorktreeFamily(scratchDir, { bare: true })
  }, 60_000)

  describe.each([
    ['desktop', desktopNestedImport],
    ['runtime', runtimeNestedImport]
  ])('%s nested import', (_name, importNested) => {
    it('reuses the project a sibling registered and groups it', async () => {
      const { repos, store } = createStore()
      const direct = await writer('runtime add')(store, family.siblingA, family.parentDir)
      const result = await importNested(store, {
        parentPath: family.parentDir,
        projectPaths: [family.siblingB],
        mode: 'group',
        groupName: 'family'
      })
      expect(result.projects).toEqual([
        expect.objectContaining({ projectId: direct, status: 'already-known' })
      ])
      expect(repos).toHaveLength(1)
      expect(result.group?.id).toBeDefined()
      expect(repos[0].projectGroupId).toBe(result.group?.id)
    })

    it('keeps an independent clone as its own project', async () => {
      const { repos, store } = createStore()
      await writer('runtime add')(store, family.siblingA, family.parentDir)
      const result = await importNested(store, {
        parentPath: scratchDir,
        projectPaths: [family.clonePath],
        mode: 'separate',
        groupName: ''
      })
      expect(result.projects).toEqual([expect.objectContaining({ status: 'imported' })])
      expect(repos).toHaveLength(2)
    })
  })
})
