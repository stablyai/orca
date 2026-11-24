import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../../shared/testing/remove-temp-dirs.test-support'
import {
  PLUGIN_GIT_CLONE_TEMP_PREFIX,
  PLUGIN_GIT_LS_REMOTE_TEMP_PREFIX,
  sweepStalePluginGitTempDirs
} from './plugin-git-temp-sweep'

const roots: string[] = []
afterEach(async () => {
  await removeTempDirs(roots.splice(0))
})

const NOW = Date.parse('2026-01-01T12:00:00Z')
const TWO_HOURS = 2 * 60 * 60 * 1000

async function aged(path: string, ageMs: number): Promise<string> {
  const time = new Date(NOW - ageMs)
  await utimes(path, time, time)
  return path
}

it('removes only stale plugin Git temp folders and never follows a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-sweep-test-'))
  roots.push(root)
  const oldClone = await mkdtemp(join(root, PLUGIN_GIT_CLONE_TEMP_PREFIX))
  await mkdir(join(oldClone, 'repository'))
  await aged(oldClone, TWO_HOURS)
  await aged(await mkdtemp(join(root, PLUGIN_GIT_LS_REMOTE_TEMP_PREFIX)), TWO_HOURS)
  const freshClone = await aged(await mkdtemp(join(root, PLUGIN_GIT_CLONE_TEMP_PREFIX)), 60_000)
  const unrelated = await aged(await mkdtemp(join(root, 'orca-plugin-gitx')), TWO_HOURS)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'keep')
  await aged(outside, TWO_HOURS)
  await symlink(
    outside,
    join(root, `${PLUGIN_GIT_CLONE_TEMP_PREFIX}Linked`),
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  expect(await sweepStalePluginGitTempDirs(root, NOW)).toBe(2)

  expect((await readdir(root)).sort()).toEqual(
    [
      freshClone.slice(root.length + 1),
      unrelated.slice(root.length + 1),
      'outside',
      `${PLUGIN_GIT_CLONE_TEMP_PREFIX}Linked`
    ].sort()
  )
  expect(await readdir(outside)).toEqual(['keep.txt'])
})
