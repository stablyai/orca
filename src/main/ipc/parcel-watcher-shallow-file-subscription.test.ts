import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-metadata-files'
import {
  MISSING_FILE_SWEEP_INTERVAL_MS,
  startShallowFileWatcher
} from './parcel-watcher-shallow-file-subscription'
import type { ShallowWatcherSubscription } from './parcel-watcher-shallow-subscription'

let commonDir: string
let subscription: ShallowWatcherSubscription | null
let paths: string[]

beforeEach(() => {
  commonDir = mkdtempSync(join(tmpdir(), 'orca-shallow-file-watch-'))
  for (const directory of ['logs', 'objects/ab', 'refs/heads', 'worktrees/feature', 'lfs']) {
    mkdirSync(join(commonDir, directory), { recursive: true })
  }
  // packed-refs and config.worktree are deliberately absent at start.
  for (const name of ['HEAD', 'index', 'config', 'logs/HEAD']) {
    writeFileSync(join(commonDir, name), 'initial')
  }
  subscription = null
  paths = []
})

afterEach(async () => {
  await subscription?.unsubscribe()
  rmSync(commonDir, { recursive: true, force: true })
})

function start(): void {
  subscription = startShallowFileWatcher(
    commonDir,
    PRIMARY_CHECKOUT_METADATA_FILES,
    (events) => paths.push(...events.map((event) => event.path)),
    (error) => {
      throw error
    }
  )
}

function replaceLikeGit(name: string, content: string): void {
  const path = join(commonDir, name)
  writeFileSync(`${path}.lock`, content)
  renameSync(`${path}.lock`, path)
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150))
}

async function expectEventFor(name: string): Promise<void> {
  await vi.waitFor(() => expect(paths).toContain(join(commonDir, name)), { timeout: 5_000 })
}

describe('shallow file watcher', () => {
  it('ignores object, ref, lfs and linked-worktree churn under the common dir', async () => {
    start()
    await settle()
    paths = []

    writeFileSync(join(commonDir, 'objects/ab/cdef'), 'blob')
    writeFileSync(join(commonDir, 'refs/heads/topic'), 'sha')
    writeFileSync(join(commonDir, 'worktrees/feature/index'), 'index')
    writeFileSync(join(commonDir, 'worktrees/feature/HEAD'), 'ref')
    writeFileSync(join(commonDir, 'lfs/object'), 'large')
    writeFileSync(join(commonDir, 'FETCH_HEAD'), 'fetched')
    await settle()

    expect(paths).toEqual([])
  })

  it('reports git lock-file replacements of the index every time', async () => {
    start()
    await settle()

    for (const content of ['one', 'two', 'three']) {
      paths = []
      replaceLikeGit('index', content)
      await expectEventFor('index')
      await settle()
    }
  })

  it('reports appends to the nested reflog', async () => {
    start()
    await settle()
    paths = []

    writeFileSync(join(commonDir, 'logs/HEAD'), 'initial\nmoved', { flag: 'w' })

    await expectEventFor('logs/HEAD')
  })

  it('picks up a metadata file created after start when a sibling changes', async () => {
    start()
    await settle()
    paths = []

    writeFileSync(join(commonDir, 'packed-refs'), 'packed')
    replaceLikeGit('HEAD', 'ref: refs/heads/topic')

    await expectEventFor('HEAD')
    await expectEventFor('packed-refs')
    paths = []
    replaceLikeGit('packed-refs', 'repacked')
    await expectEventFor('packed-refs')
  })

  it('finds a metadata file created later with no sibling write, as pack-refs does', async () => {
    start()
    await settle()
    paths = []

    replaceLikeGit('packed-refs', 'packed')

    await vi.waitFor(() => expect(paths).toContain(join(commonDir, 'packed-refs')), {
      timeout: MISSING_FILE_SWEEP_INTERVAL_MS + 3_000
    })
  })

  it('reports a missing root as a watch error', async () => {
    const onError = vi.fn()
    subscription = startShallowFileWatcher(join(commonDir, 'missing'), ['HEAD'], () => {}, onError)
    expect(onError).toHaveBeenCalledOnce()
  })
})
