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
    // Retry writes until observed to tolerate native delivery gaps under CI load.
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

    // Prove both watch levels are live before checking ignored events.
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
    // A post-storm sentinel at each level proves prior events arrived without a fixed sleep.
    await writeUntilSeen([join(root, 'sentinel.ts'), join(nestedSource, 'sentinel.ts')])

    expect(errors).toEqual([])
    const generatedPaths = new Set(generatedFiles)
    expect(events.filter((event) => generatedPaths.has(event.path))).toEqual([])
  })
})
