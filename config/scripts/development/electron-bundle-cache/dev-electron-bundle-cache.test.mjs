import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  collectDevBundles,
  DEV_BUNDLE_MARKER_FILENAME,
  selectStaleDevBundleDirs
} from './dev-electron-bundle-cache.mjs'

let worktree
afterEach(async () => {
  if (worktree) {
    await rm(worktree, { recursive: true, force: true })
    worktree = undefined
  }
})

it('keeps a sibling worktree bundle that finished building but has not spawned yet', async () => {
  worktree = await mkdtemp(join(tmpdir(), 'orca-dev-bundle-'))
  const launching = join(worktree, 'out', 'electron-dev', 'launching')
  const idle = join(worktree, 'out', 'electron-dev', 'idle')
  for (const dir of [launching, idle]) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, DEV_BUNDLE_MARKER_FILENAME), '{}')
  }
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(idle, twoHoursAgo, twoHoursAgo)

  expect(
    selectStaleDevBundleDirs({
      bundles: collectDevBundles(worktree),
      currentDir: null,
      processTable: '',
      nowMs: Date.now()
    })
  ).toEqual([idle])
})
