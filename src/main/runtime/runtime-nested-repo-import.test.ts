import { runProcessSync } from '@orca/process-host'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RuntimeNestedRepoImport } from './runtime-nested-repo-import'
import type { RuntimeStore } from './runtime-store-contract'

function runGit(args: string[]): void {
  const result = runProcessSync({ program: 'git', args })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

function initRepo(path: string): void {
  runGit(['init', '-q', path])
  runGit([
    '-C',
    path,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  ])
}

function createImporter(): { importer: RuntimeNestedRepoImport; repos: Repo[] } {
  const repos: Repo[] = []
  const store = {
    getRepos: () => repos,
    addRepo: (repo: Repo) => {
      repos.push(repo)
      return repo
    },
    createProjectGroup: () => ({ id: 'group-1', name: 'Group' }),
    moveProjectToGroup: () => null,
    deleteProjectGroup: () => {}
  }
  const importer = new RuntimeNestedRepoImport({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: import() only uses the store members defined above.
    getStore: () => store as unknown as RuntimeStore,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })
  return { importer, repos }
}

describe('RuntimeNestedRepoImport new Git repository observer', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-nested-')))
    await mkdir(join(root, 'api'))
    await mkdir(join(root, 'web'))
    initRepo(join(root, 'api'))
    initRepo(join(root, 'web'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const importArgs = (dirs: string[]) => ({
    parentPath: root,
    groupName: 'Group',
    projectPaths: dirs.map((dir) => join(root, dir)),
    mode: 'group' as const
  })

  it('reports each newly imported repo once and none on a repeat import', async () => {
    const { importer, repos } = createImporter()
    const observer = vi.fn()

    const first = await importer.import(importArgs(['api', 'web']), observer)
    const repeat = await importer.import(importArgs(['api', 'web']), observer)

    expect(first).toMatchObject({ importedCount: 2 })
    expect(repeat).toMatchObject({ importedCount: 0, alreadyKnownCount: 2 })
    expect(observer).toHaveBeenCalledTimes(2)
    expect(observer.mock.calls.map(([repo]) => repo)).toEqual(repos)
  })

  it('does not report a repo that was already tracked', async () => {
    const { importer, repos } = createImporter()
    const observer = vi.fn()
    await importer.import(importArgs(['api']))

    await importer.import(importArgs(['api', 'web']), observer)

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(repos[1])
  })

  it('keeps the import when the observer throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { importer, repos } = createImporter()

    const result = await importer.import(importArgs(['api']), () => {
      throw new Error('consumer failed')
    })

    expect(result).toMatchObject({ importedCount: 1, failedCount: 0 })
    expect(repos).toHaveLength(1)
    warn.mockRestore()
  })
})
