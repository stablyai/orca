import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as InstrumentationModule from '../observability/instrumentation'
import type * as RefMaintenanceModule from '../git/local-repo-ref-maintenance'

type GitResult = { stdout: string; stderr: string }
type SpawnedGit = {
  args: string[]
  resolve: (result: GitResult) => void
  reject: (error: Error) => void
}

const spawned = vi.hoisted((): { fetches: SpawnedGit[]; gitCommonDir: string } => ({
  fetches: [],
  gitCommonDir: ''
}))

// The git process is the only fake: the runner's wrapper and the repo's fetch lock above it are real.
vi.mock('../observability/instrumentation', async (importOriginal) => ({
  ...(await importOriginal<typeof InstrumentationModule>()),
  withGitSpan: ({ args }: { args: string[] }) => {
    if (args[0] === 'rev-parse') {
      return Promise.resolve({ stdout: `${spawned.gitCommonDir}\n`, stderr: '' })
    }
    return new Promise<GitResult>((resolve, reject) => {
      spawned.fetches.push({ args, resolve, reject })
    })
  }
}))

vi.mock('../git/local-repo-ref-maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof RefMaintenanceModule>()),
  armLocalRepoRefMaintenance: vi.fn(),
  setRepoRefMaintenanceBusyProbe: vi.fn()
}))

import { _resetCanonicalRepoKeyCacheForTests } from '../git/canonical-repo-key'
import { setRepoRefMaintenanceBusyProbe } from '../git/local-repo-ref-maintenance'
import { RuntimeRemoteFetchController } from './runtime-remote-fetch-controller'

const base = {
  remote: 'origin',
  branch: 'main',
  ref: 'refs/remotes/origin/main',
  base: 'origin/main'
}
const ok: GitResult = { stdout: '', stderr: '' }

let repo = ''

function spawnedArgs(): string[][] {
  return spawned.fetches.map((fetch) => fetch.args)
}

async function waitForSpawnCount(count: number): Promise<void> {
  await vi.waitFor(() => expect(spawned.fetches).toHaveLength(count))
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

beforeEach(() => {
  _resetCanonicalRepoKeyCacheForTests()
  repo = mkdtempSync(path.join(tmpdir(), 'orca-create-fetch-'))
  mkdirSync(path.join(repo, '.git'))
  spawned.fetches = []
  spawned.gitCommonDir = path.join(repo, '.git')
  vi.mocked(setRepoRefMaintenanceBusyProbe).mockClear()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe("a create's own base fetch", () => {
  it('goes ahead of queued background fetches and waits only for the one already running', async () => {
    const controller = new RuntimeRemoteFetchController()
    const runningFetch = controller.getOrStartRemoteFetch(repo, 'origin')
    await waitForSpawnCount(1)
    // Queued at the repo's fetch lock behind the running fetch.
    const lockWaiter = controller.getOrStartRemoteFetch(repo, 'upstream')
    // Queued in the origin refresh chain behind the running fetch.
    const queuedRefresh = controller.getOrStartRemoteTrackingBaseRefresh(repo, base)

    const createFetch = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    await settle()
    expect(spawned.fetches).toHaveLength(1)

    spawned.fetches[0]?.resolve(ok)
    await waitForSpawnCount(2)
    expect(spawnedArgs()[1]).toEqual(
      expect.arrayContaining([
        'fetch',
        '--no-tags',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main'
      ])
    )
    spawned.fetches[1]?.resolve(ok)
    await expect(createFetch).resolves.toEqual({ ok: true })

    await waitForSpawnCount(3)
    expect(spawnedArgs()[2]).toEqual(['fetch', 'upstream'])
    spawned.fetches[2]?.resolve(ok)
    await settle()
    // The queued refresh reached its turn while the create's fetch ran, and joined it.
    expect(spawned.fetches).toHaveLength(3)
    await expect(Promise.all([runningFetch, lockWaiter, queuedRefresh])).resolves.toEqual([
      { ok: true },
      { ok: true },
      { ok: true }
    ])
  })

  it('is one fetch shared by concurrent creates of the same base', async () => {
    const controller = new RuntimeRemoteFetchController()
    const first = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    const second = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    await waitForSpawnCount(1)
    spawned.fetches[0]?.resolve(ok)
    await settle()

    expect(spawned.fetches).toHaveLength(1)
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
  })

  it("joins the composer's refresh of the same base once that refresh is running", async () => {
    const controller = new RuntimeRemoteFetchController()
    const prefetch = controller.getOrStartRemoteTrackingBaseRefresh(repo, base)
    await waitForSpawnCount(1)

    const createFetch = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    await settle()
    spawned.fetches[0]?.resolve(ok)
    await settle()

    expect(spawned.fetches).toHaveLength(1)
    await expect(Promise.all([prefetch, createFetch])).resolves.toEqual([
      { ok: true },
      { ok: true }
    ])
  })

  it("keeps its lock priority when it joins the composer's refresh waiting at the fetch lock", async () => {
    const controller = new RuntimeRemoteFetchController()
    const runningFetch = controller.getOrStartRemoteFetch(repo, 'upstream')
    await waitForSpawnCount(1)
    const backgroundWaiter = controller.getOrStartRemoteFetch(repo, 'fork')
    // Left the origin chain at once, so it is queued at the lock behind the background waiter's turn.
    const prefetch = controller.getOrStartRemoteTrackingBaseRefresh(repo, base)
    await settle()
    const createFetch = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    await settle()

    spawned.fetches[0]?.resolve(ok)
    await waitForSpawnCount(2)
    expect(spawnedArgs()[1]).toEqual(
      expect.arrayContaining(['+refs/heads/main:refs/remotes/origin/main'])
    )
    spawned.fetches[1]?.resolve(ok)
    await expect(Promise.all([prefetch, createFetch])).resolves.toEqual([
      { ok: true },
      { ok: true }
    ])

    await waitForSpawnCount(3)
    expect(spawnedArgs()[2]).toEqual(['fetch', 'fork'])
    spawned.fetches[2]?.resolve(ok)
    await expect(Promise.all([runningFetch, backgroundWaiter])).resolves.toEqual([
      { ok: true },
      { ok: true }
    ])
  })

  it('reports a failed shared fetch to every create, and the next create fetches again', async () => {
    const controller = new RuntimeRemoteFetchController()
    const first = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    const second = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    await waitForSpawnCount(1)
    spawned.fetches[0]?.reject(new Error('network down'))
    await settle()

    expect(spawned.fetches).toHaveLength(1)
    const failed = { ok: false, errorKind: 'git_error' }
    await expect(Promise.all([first, second])).resolves.toEqual([failed, failed])

    const retry = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    await waitForSpawnCount(2)
    spawned.fetches[1]?.resolve(ok)
    await expect(retry).resolves.toEqual({ ok: true })
  })

  it('keeps ref maintenance off the repo until the shared fetch finishes', async () => {
    const controller = new RuntimeRemoteFetchController()
    const other = { ...base, branch: 'dev', ref: 'refs/remotes/origin/dev', base: 'origin/dev' }
    const warmup = controller.refreshRemoteTrackingBaseForCreate(repo, other)
    await waitForSpawnCount(1)
    spawned.fetches[0]?.resolve(ok)
    await warmup
    await vi.waitFor(() => expect(setRepoRefMaintenanceBusyProbe).toHaveBeenCalled())
    const isBusy = vi.mocked(setRepoRefMaintenanceBusyProbe).mock.calls[0]?.[1]

    const first = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    const second = controller.refreshRemoteTrackingBaseForCreate(repo, base)
    await waitForSpawnCount(2)
    expect(isBusy?.()).toBe(true)
    spawned.fetches[1]?.resolve(ok)
    await settle()
    expect(isBusy?.()).toBe(false)
    expect(spawned.fetches).toHaveLength(2)
    await Promise.all([first, second])
  })

  it('reuses a base fetch that completed moments ago', async () => {
    const controller = new RuntimeRemoteFetchController()
    const refresh = controller.getOrStartRemoteTrackingBaseRefresh(repo, base)
    await waitForSpawnCount(1)
    spawned.fetches[0]?.resolve(ok)
    await refresh

    await expect(controller.refreshRemoteTrackingBaseForCreate(repo, base)).resolves.toEqual({
      ok: true
    })
    expect(spawned.fetches).toHaveLength(1)
  })
})
