// Real Git proves sibling worktrees share one project however their adds interleave.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'

const metadataGates = vi.hoisted(() => new Map<string, Promise<void>>())
const metadataArrivals = vi.hoisted((): string[] => [])
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
  createScratch,
  createStore,
  createWorktreeFamily,
  createWriters,
  runtimeNestedImport,
  type Writer
} from './checkout-family-real-git.test-fixture'

installRealWorkerThreadChildProcesses()

let scratchDir = ''
let family: Awaited<ReturnType<typeof createWorktreeFamily>>

// The desktop nested import needs Electron IPC; the host-identity suite covers it.
const unusedDesktopNestedImport = () => Promise.reject(new Error('desktop nested import unused'))
const registrars: [string, Writer][] = createWriters(unusedDesktopNestedImport).filter(([name]) =>
  ['desktop add', 'runtime add'].includes(name)
)

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

beforeEach(async () => {
  scratchDir = await createScratch('orca-checkout-family-')
  family = await createWorktreeFamily(scratchDir)
  metadataGates.clear()
  metadataArrivals.length = 0
  // Real Git fixture setup can exceed the default hook budget on a busy machine.
}, 60_000)

afterEach(async () => {
  metadataGates.clear()
  await removeTree(scratchDir)
}, 60_000)

describe.each(registrars)('%s registration of linked worktrees', (_owner, register) => {
  const add = (store: Parameters<Writer>[0], path: string) =>
    register(store, path, family.parentDir)

  it('reuses the project an earlier sibling worktree registered', async () => {
    const { repos, store } = createStore()
    const first = await add(store, family.siblingA)
    const second = await add(store, family.siblingB)
    expect(second).toBe(first)
    expect(repos).toHaveLength(1)
  })

  it.each([
    ['A first', 0],
    ['B first', 1]
  ])('registers one project when sibling adds overlap (%s)', async (_order, firstIndex) => {
    const { repos, store } = createStore()
    const paths = [family.siblingA, family.siblingB]
    const opens = paths.map(gate)
    const adds = paths.map((path) => add(store, path))
    // Both adds are now past their pre-metadata checks against an empty store.
    await vi.waitFor(() => expect(metadataArrivals).toHaveLength(2), { timeout: 30_000 })
    opens[firstIndex]()
    await adds[firstIndex]
    opens[1 - firstIndex]()
    const [a, b] = await Promise.all(adds)
    expect(a).toBe(b)
    expect(repos).toHaveLength(1)
  })

  it('keeps an independent clone as its own project', async () => {
    const { repos, store } = createStore()
    await add(store, family.siblingA)
    await add(store, family.clonePath)
    expect(repos).toHaveLength(2)
  })
})

describe('runtime nested import of a linked worktree family', () => {
  it('reuses the project a direct add registered for a sibling worktree', async () => {
    const { repos, store } = createStore()
    const direct = await registrars[1][1](store, family.siblingB, family.parentDir)
    const result = await runtimeNestedImport(store, {
      parentPath: family.parentDir,
      groupName: '',
      projectPaths: [family.siblingA],
      mode: 'separate'
    })
    expect(result.projects).toEqual([
      expect.objectContaining({ projectId: direct, status: 'already-known' })
    ])
    expect(repos).toHaveLength(1)
  })
})
