import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import { getRepositoryStatuses } from './repository-status'

const exec = promisify(execFile)
let scratch: string | undefined
afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

it('reads independent nested and linked repositories without walking up, and queries only demanded ignores', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orca-nested-status-'))
  const outer = join(scratch, 'outer')
  const git = async (cwd: string, ...args: string[]) =>
    exec('git', [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=orca-test@example.invalid',
      '-c',
      `core.hooksPath=${join(scratch!, 'no-hooks')}`,
      '-C',
      cwd,
      ...args
    ])
  const init = async (path: string) => {
    await mkdir(path, { recursive: true })
    await git(path, 'init', '-b', 'main')
  }
  await init(outer)
  const tracked = join(outer, 'tracked-child')
  await mkdir(tracked)
  await writeFile(join(tracked, 'existing.txt'), 'tracked by outer')
  await git(outer, 'add', '.')
  await git(outer, 'commit', '-m', 'base')
  await init(tracked)
  const nested = join(outer, 'nested')
  await init(nested)
  await writeFile(join(nested, '.gitignore'), '*.tmp\n')
  await writeFile(join(nested, 'forced.tmp'), 'tracked despite rule')
  await git(nested, 'add', '.gitignore')
  await git(nested, 'add', '-f', 'forced.tmp')
  await git(nested, 'commit', '-m', 'base')
  await writeFile(join(nested, 'new.txt'), 'child pending')
  await writeFile(join(nested, 'hidden.tmp'), 'ignored')
  await git(nested, 'worktree', 'add', join(outer, 'linked'), '-b', 'linked')
  await writeFile(join(outer, 'linked', 'linked.txt'), 'linked pending')
  await mkdir(join(outer, 'plain'))
  await mkdir(join(outer, 'broken'))
  await writeFile(join(outer, 'broken', '.git'), 'gitdir: missing\n')

  const probe = await getRepositoryStatuses(outer, {
    repositoryPaths: ['nested', 'tracked-child', 'linked', 'plain', 'broken'],
    repositoryIntent: 'probe'
  })
  expect(probe.repositoryStatuses).toEqual([
    { path: 'nested', kind: 'repository' },
    { path: 'tracked-child', kind: 'repository' },
    { path: 'linked', kind: 'repository' },
    { path: 'plain', kind: 'absent' },
    { path: 'broken', kind: 'repository' }
  ])
  const status = async (root: string, path: string) =>
    (await getRepositoryStatuses(root, { repositoryPaths: [path], repositoryIntent: 'status' }))
      .repositoryStatuses![0]
  expect((await status(outer, 'nested')).status?.entries.map((entry) => entry.path)).toEqual([
    'new.txt'
  ])
  expect((await status(outer, 'tracked-child')).status?.entries.map((entry) => entry.path)).toEqual(
    ['existing.txt']
  )
  expect((await status(outer, 'linked')).status?.entries.map((entry) => entry.path)).toEqual([
    'linked.txt'
  ])
  expect((await status(nested, '')).status?.entries.map((entry) => entry.path)).toEqual(['new.txt'])
  expect((await status(outer, 'nested')).status?.ignoredPaths).toBeUndefined()
  expect(await status(outer, 'broken')).toEqual({ path: 'broken', kind: 'unknown' })
  const ignored = async () =>
    (
      await getRepositoryStatuses(outer, {
        repositoryPaths: ['nested'],
        repositoryIntent: 'ignored',
        repositoryQueryPaths: ['hidden.tmp', 'forced.tmp', 'new.txt']
      })
    ).repositoryStatuses![0]
  expect((await ignored()).ignoredPaths).toEqual(['hidden.tmp'])
  for (const population of [100, 1000]) {
    await mapWithConcurrency(
      Array.from({ length: population }, (_, index) => index),
      4,
      (index) => writeFile(join(nested, `corpus-${index}.tmp`), 'ignored')
    )
    expect((await status(outer, 'nested')).status?.entries.map((entry) => entry.path)).toEqual([
      'new.txt'
    ])
    expect((await ignored()).ignoredPaths).toEqual(['hidden.tmp'])
  }

  await writeFile(join(nested, '.gitignore'), '')
  expect((await ignored()).ignoredPaths).toEqual([])
  await rm(join(nested, '.git'), { recursive: true })
  expect(await status(outer, 'nested')).toEqual({ path: 'nested', kind: 'absent' })
  await expect(status(outer, '../escape')).rejects.toThrow('invalid_relative_path')
  await expect(status(outer, 'C:escape')).rejects.toThrow('invalid_relative_path')
  await expect(status(outer, 'bad\0path')).rejects.toThrow('invalid_relative_path')
  const outside = join(scratch, 'outside')
  await init(outside)
  await symlink(outside, join(outer, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await status(outer, 'escape')).toEqual({ path: 'escape', kind: 'unknown' })
  await mkdir(join(outside, 'inside'))
  expect(await status(outer, 'escape/inside')).toEqual({ path: 'escape/inside', kind: 'unknown' })
})
