import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribe, type AsyncSubscription, type Event } from '@parcel/watcher'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WATCHER_IGNORE_DIRS, buildParcelWatcherIgnoreOptions } from './filesystem-watcher-ignore'

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
    await Promise.all(sourceFiles.map((file) => writeFile(file, 'source')))

    await vi.waitFor(
      () => {
        for (const sourceFile of sourceFiles) {
          expect(events.some((event) => event.path === sourceFile)).toBe(true)
        }
      },
      { timeout: 8_000 }
    )
    // Why: ignored callbacks must stay absent after the native debounce has drained.
    await new Promise((resolve) => setTimeout(resolve, 300))
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
      writeFile(parentSource, 'parent source'),
      writeFile(worktreeSource, 'worktree source')
    ])
    await vi.waitFor(
      () => {
        expect(parentEvents.some((event) => event.path === parentSource)).toBe(true)
        expect(worktreeEvents.some((event) => event.path === worktreeSource)).toBe(true)
      },
      { timeout: 8_000 }
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(errors).toEqual([])
    expect(parentEvents.filter((event) => event.path === worktreeSource)).toEqual([])
  })
})
