import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribe, type AsyncSubscription, type Event } from '@parcel/watcher'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WATCHER_IGNORE_DIRS, buildParcelWatcherIgnoreOptions } from './filesystem-watcher-ignore'

const DELIVERY_TIMEOUT_MS = 8_000

// Retry writes until observed to tolerate native delivery gaps under CI load.
async function writeUntilSeen(events: Event[], files: string[]): Promise<void> {
  await vi.waitFor(
    async () => {
      const missing = files.filter((file) => !events.some((event) => event.path === file))
      await Promise.all(missing.map((file) => writeFile(file, 'source')))
      expect(missing).toEqual([])
    },
    { timeout: DELIVERY_TIMEOUT_MS, interval: 200 }
  )
}

describe('filesystem watcher native ignores', () => {
  let root: string | null = null
  let subscription: AsyncSubscription | null = null
  let worktreeSubscription: AsyncSubscription | null = null

  afterEach(async () => {
    await worktreeSubscription?.unsubscribe()
    worktreeSubscription = null
    await subscription?.unsubscribe()
    subscription = null
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = null
    }
  })

  it('drops root and nested generated-file storms while delivering source edits', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-watch-ignore-')))
    const rootModules = join(root, 'node_modules')
    const nestedModules = join(root, 'packages', 'app', 'node_modules')
    const rootWorktrees = join(root, '.worktrees', 'task', 'src')
    const nestedWorktrees = join(root, 'packages', 'app', '.worktrees', 'task', 'src')
    const ignoredDirectories = [rootModules, nestedModules, rootWorktrees, nestedWorktrees]
    const nestedSource = join(root, 'packages', 'app', 'src')
    await Promise.all(
      [...ignoredDirectories, nestedSource].map((directory) =>
        mkdir(directory, { recursive: true })
      )
    )

    const events: Event[] = []
    const errors: Error[] = []
    subscription = await subscribe(
      root,
      (error, batch) => {
        if (error) {
          errors.push(error)
        }
        events.push(...batch)
      },
      buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
    )
    // Prove both watch levels are live before checking ignored events.
    await writeUntilSeen(events, [join(root, 'ready.ts'), join(nestedSource, 'ready.ts')])

    const generatedNames = Array.from({ length: 20 }, (_, index) => `generated-${index}.js`)
    // Windows forbids control characters in filenames.
    if (process.platform !== 'win32') {
      generatedNames.push('generated\nnewline.js')
    }
    const generatedFiles = ignoredDirectories.flatMap((directory) =>
      generatedNames.map((name) => join(directory, name))
    )
    await Promise.all(generatedFiles.map((file) => writeFile(file, 'generated')))
    const sourceFiles = [join(root, 'source.ts'), join(nestedSource, 'source.ts')]
    if (process.platform !== 'win32') {
      sourceFiles.push(join(root, 'source\nnewline.ts'), join(nestedSource, 'source\nnewline.ts'))
    }
    await writeUntilSeen(events, sourceFiles)
    // A post-storm sentinel at each level proves prior events arrived without a fixed sleep.
    await writeUntilSeen(events, [join(root, 'sentinel.ts'), join(nestedSource, 'sentinel.ts')])

    expect(errors).toEqual([])
    const generatedPaths = new Set(generatedFiles)
    expect(events.filter((event) => generatedPaths.has(event.path))).toEqual([])
  })

  it('delivers nested worktree edits to its own watcher without waking the parent', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-watch-worktree-')))
    const worktreeRoot = join(root, '.worktrees', 'task')
    await mkdir(join(worktreeRoot, 'src'), { recursive: true })

    const parentEvents: Event[] = []
    const worktreeEvents: Event[] = []
    const errors: Error[] = []
    const options = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
    subscription = await subscribe(
      root,
      (error, batch) => {
        if (error) {
          errors.push(error)
        }
        parentEvents.push(...batch)
      },
      options
    )
    worktreeSubscription = await subscribe(
      worktreeRoot,
      (error, batch) => {
        if (error) {
          errors.push(error)
        }
        worktreeEvents.push(...batch)
      },
      options
    )

    const parentSource = join(root, 'source.ts')
    const worktreeSource = join(worktreeRoot, 'src', 'source.ts')
    await Promise.all([
      writeUntilSeen(parentEvents, [parentSource]),
      writeUntilSeen(worktreeEvents, [worktreeSource])
    ])
    await Promise.all([
      writeUntilSeen(parentEvents, [join(root, 'sentinel.ts')]),
      writeUntilSeen(worktreeEvents, [join(worktreeRoot, 'src', 'sentinel.ts')])
    ])
    expect(errors).toEqual([])
    expect(parentEvents.filter((event) => event.path === worktreeSource)).toEqual([])
  })
})
