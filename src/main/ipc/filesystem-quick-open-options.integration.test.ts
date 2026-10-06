import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Store } from '../persistence'
import { listQuickOpenFiles } from './filesystem-list-files'
import { listFilesWithRg } from '../../relay/fs-handler-list-files'
import { searchQuickOpenFilePaths } from './filesystem-search-file-paths'
import { bundledRipgrepCommand } from '../ripgrep/bundled-ripgrep-path'
import { configureRelayBundledRipgrep } from '../../relay/relay-bundled-ripgrep'

const fixtures: string[] = []
beforeEach(() => configureRelayBundledRipgrep(bundledRipgrepCommand()))
afterEach(async () => {
  configureRelayBundledRipgrep(undefined)
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('honors inherited ignores, opt-in links, cycles, retargets and relay parity in real processes', async () => {
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
    const relay = await listFilesWithRg(root, [], options)
    expect(local.sort()).toEqual(relay.sort())
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

it('validates recent membership independently of top32, ignores, exclusions and a real inventory cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-quick-open-recents-'))
  fixtures.push(root)
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'excluded'))
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, '.gitignore'), 'ignored.ts\n')
  await writeFile(join(root, '.ignore'), 'always-ignored.ts\n')
  await Promise.all(
    [
      'ignored.ts',
      'always-ignored.ts',
      'excluded/other.ts',
      'node_modules/blocked.ts',
      ...Array.from({ length: 60 }, (_, i) => `src/file${String(i).padStart(3, '0')}.ts`)
    ].map((path) => writeFile(join(root, path), 'fixture'))
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only these store methods.
  const store = {
    getRepos: () => [{ id: 'fixture', path: root }],
    getSettings: () => ({}),
    getFolderWorkspaces: () => []
  } as unknown as Store
  const top = await listFilesWithRg(root, [], {
    searchQuery: 'file',
    maxResults: 32,
    includeIgnored: false
  })
  expect(top).toHaveLength(32)
  expect(top).not.toContain('src/file059.ts')
  const candidates = [
    'src/file059.ts',
    'deleted.ts',
    'ignored.ts',
    'always-ignored.ts',
    'excluded/other.ts',
    'node_modules/blocked.ts'
  ]
  const options = { includeIgnored: false, candidatePaths: candidates }
  const local = await listQuickOpenFiles(
    root,
    store,
    [join(root, 'excluded')],
    undefined,
    candidates.length,
    undefined,
    undefined,
    options
  )
  const relay = await listFilesWithRg(root, ['excluded'], {
    ...options,
    maxResults: candidates.length
  })
  expect(local).toEqual(['src/file059.ts'])
  expect(relay).toEqual(local)
  const broad = await listFilesWithRg(root, ['excluded'], {
    ...options,
    includeIgnored: true,
    maxResults: candidates.length
  })
  expect(broad.sort()).toEqual(['ignored.ts', 'src/file059.ts'])
  await mkdir(join(root, 'large'))
  for (let start = 0; start < 20_020; start += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, 20_020 - start) }, (_, offset) =>
        writeFile(join(root, 'large', `entry${start + offset}.ts`), 'x')
      )
    )
  }
  const capped = await listQuickOpenFiles(root, store, undefined, undefined, 20_001)
  expect(capped).toHaveLength(20_001)
  const available = new Set(capped)
  const missing = Array.from({ length: 20_020 }, (_, i) => `large/entry${i}.ts`).find(
    (path) => !available.has(path)
  )
  expect(missing).toBeDefined()
  if (!missing) {
    throw new Error('fixture must exceed the cap')
  }
  expect(
    await listQuickOpenFiles(root, store, undefined, undefined, 1, undefined, undefined, {
      candidatePaths: [missing],
      includeIgnored: false
    })
  ).toEqual([missing])
  expect(
    await listFilesWithRg(root, [], {
      candidatePaths: [missing],
      includeIgnored: false,
      maxResults: 1
    })
  ).toEqual([missing])
}, 60_000)
