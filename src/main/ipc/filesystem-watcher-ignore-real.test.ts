import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribe, type AsyncSubscription, type Event } from '@parcel/watcher'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WATCHER_IGNORE_DIRS, buildParcelWatcherIgnoreOptions } from './filesystem-watcher-ignore'

const DELIVERY_TIMEOUT_MS = 8_000

describe('filesystem watcher native ignores', () => {
  let root: string | null = null
  let subscription: AsyncSubscription | null = null

  afterEach(async () => {
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
    const nestedSource = join(root, 'packages', 'app', 'src')
    await Promise.all(
      [rootModules, nestedModules, nestedSource].map((directory) =>
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
    const seen = (file: string): boolean => events.some((event) => event.path === file)
    // Why: under CI load a single write can miss delivery, so rewrite until each file is seen.
    const writeUntilSeen = async (files: string[]): Promise<void> => {
      await vi.waitFor(
        async () => {
          const missing = files.filter((file) => !seen(file))
          await Promise.all(missing.map((file) => writeFile(file, 'source')))
          expect(missing).toEqual([])
        },
        { timeout: DELIVERY_TIMEOUT_MS, interval: 200 }
      )
    }

    // Proves both watched levels are live before the storm, so the ignore check can't pass vacuously.
    await writeUntilSeen([join(root, 'ready.ts'), join(nestedSource, 'ready.ts')])

    const generatedNames = Array.from({ length: 20 }, (_, index) => `generated-${index}.js`)
    // Windows forbids control characters in filenames.
    if (process.platform !== 'win32') {
      generatedNames.push('generated\nnewline.js')
    }
    const generatedFiles = [rootModules, nestedModules].flatMap((directory) =>
      generatedNames.map((name) => join(directory, name))
    )
    await Promise.all(generatedFiles.map((file) => writeFile(file, 'generated')))
    const sourceFiles = [join(root, 'source.ts'), join(nestedSource, 'source.ts')]
    if (process.platform !== 'win32') {
      sourceFiles.push(join(root, 'source\nnewline.ts'), join(nestedSource, 'source\nnewline.ts'))
    }
    await writeUntilSeen(sourceFiles)
    // Why: events arrive in order, so once a file written after the storm is seen at both levels, any
    // unignored generated event is already recorded. Replaces a fixed debounce sleep.
    await writeUntilSeen([join(root, 'sentinel.ts'), join(nestedSource, 'sentinel.ts')])

    expect(errors).toEqual([])
    const generatedPaths = new Set(generatedFiles)
    expect(events.filter((event) => generatedPaths.has(event.path))).toEqual([])
  })
})
