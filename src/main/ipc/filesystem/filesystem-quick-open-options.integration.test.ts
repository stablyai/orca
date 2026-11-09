import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import { listQuickOpenFiles } from './filesystem-list-files'
import { searchQuickOpenFilePaths } from './filesystem-search-file-paths'

const fixtures: string[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('honors inherited ignores, opt-in links, cycles, and retargets in real processes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'orca-quick-open-options-'))
  fixtures.push(parent)
  await mkdir(join(parent, '.git'))
  const root = join(parent, 'project')
  const external = join(parent, 'external')
  await mkdir(join(root, 'apps', 'api'), { recursive: true })
  await mkdir(external)
  await writeFile(join(parent, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(root, 'ignored.txt'), 'ignored')
  await writeFile(join(root, 'apps', 'api', '.env'), 'api')
  await writeFile(join(external, 'linked.md'), 'external')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(external, join(root, 'linked'), linkType)
  await symlink(root, join(root, 'cycle'), linkType)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing authorization only reads these store methods.
  const store = {
    getRepos: () => [{ id: 'fixture', path: root }],
    getSettings: () => ({}),
    getFolderWorkspaces: () => []
  } as unknown as Store
  for (const options of [
    { includeIgnored: true, followSymlinks: false },
    { includeIgnored: false, followSymlinks: false },
    { includeIgnored: false, followSymlinks: true }
  ]) {
    const local = await listQuickOpenFiles(
      root,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options
    )
    expect(local.includes('ignored.txt')).toBe(options.includeIgnored)
    expect(local.includes('linked/linked.md')).toBe(options.followSymlinks)
    expect(local).not.toContain('cycle/apps/api/.env')
  }
  expect(
    (
      await searchQuickOpenFilePaths(root, store, {
        query: '.env api',
        limit: 32,
        includeIgnored: false
      })
    ).paths
  ).toEqual(['apps/api/.env'])
  await writeFile(join(external, 'fresh.md'), 'new')
  const options = { followSymlinks: true, includeIgnored: false }
  expect(
    await listQuickOpenFiles(
      root,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options
    )
  ).toContain('linked/fresh.md')
  await rm(join(root, 'linked'))
  await symlink(join(root, 'apps'), join(root, 'linked'), linkType)
  const reopened = await listQuickOpenFiles(
    root,
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options
  )
  expect(reopened).toContain('linked/api/.env')
  expect(reopened).not.toContain('linked/fresh.md')
}, 30_000)
