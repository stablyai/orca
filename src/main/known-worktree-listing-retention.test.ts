import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  unlink,
  readFile,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { Repo } from '../shared/repo-types'
import type { Store } from './persistence/loading-store/store'
import { storeWorktreeMeta } from './runtime/runtime-store-partial-fixture'
import { retainKnownWorktreesInListing } from './known-worktree-listing-retention'
import { readWorktreeList } from './git/worktree-list-reader'
import { readWorktreeCheckout } from './git/worktree-checkout-observation'
import { pendingWorktreeRemovals } from './worktree-removal-table'

let directory: string
let repo: Repo
const options = { gitOptions: {} }
function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo.path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}
function fixture(paths: string[]): Store {
  const store: Store = Object.create(null)
  store.getWorkspaceSession = () => ({
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: Object.fromEntries(paths.map((path) => [`${repo.id}::${path}`, []]))
  })
  store.getAllWorktreeMeta = () =>
    Object.fromEntries(paths.map((path) => [`${repo.id}::${path}`, storeWorktreeMeta()]))
  store.getAllWorktreeMetaForHost = store.getAllWorktreeMeta
  return store
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'pr36536-retention-')))
  repo = {
    id: 'r',
    path: join(directory, 'repo'),
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  await mkdir(repo.path)
  git('init', '-b', 'main')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture'
  )
  pendingWorktreeRemovals.clear()
})
afterEach(async () => {
  pendingWorktreeRemovals.clear()
  await rm(directory, { recursive: true, force: true })
})

describe('saved worktree reconciliation with real Git and paths', () => {
  it('retains omitted checkouts, reconciles a physical alias once, and verifies genuine detach', async () => {
    const child = join(directory, 'child')
    git('worktree', 'add', '-b', 'feature', child)
    const alias = join(directory, 'alias')
    await symlink(child, alias, 'dir')
    const raw = await readWorktreeList(repo.path)
    const store = fixture([alias])
    const aliasRows = await retainKnownWorktreesInListing(store, repo, raw, options)
    expect(aliasRows.map((row) => row.path)).toEqual([repo.path, alias])
    expect(aliasRows[1]?.branch).toBe('refs/heads/feature')
    const main = raw.filter((row) => row.isMainWorktree)
    const retained = await retainKnownWorktreesInListing(store, repo, main, options)
    expect(retained[1]).toMatchObject({ path: alias, branch: 'refs/heads/feature' })
    git('-C', child, 'checkout', '--detach')
    expect(await readWorktreeCheckout(child)).toEqual({
      head: git('rev-parse', 'HEAD'),
      branch: ''
    })
    expect((await retainKnownWorktreesInListing(store, repo, main, options))[1]?.branch).toBe('')
    const detachedRaw = await readWorktreeList(repo.path)
    expect(
      (await retainKnownWorktreesInListing(store, repo, detachedRaw, options))[1]?.branch
    ).toBe('')
  })

  it('preserves all session and metadata owners sharing physical facts, including structural main and bare', async () => {
    const child = join(directory, 'child')
    git('worktree', 'add', '-b', 'feature', child)
    const aliases = [join(directory, 'alias1'), join(directory, 'alias2')]
    for (const alias of aliases) {
      await symlink(child, alias, 'dir')
    }
    const raw = await readWorktreeList(repo.path)
    for (const saved of [[child, ...aliases], aliases, [child, aliases[0]!]]) {
      for (const sessions of [saved, [saved[0]!], []]) {
        const store = fixture(saved)
        store.getWorkspaceSession = () => ({
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: Object.fromEntries(sessions.map((path) => [`r::${path}`, []]))
        })
        const rows = await retainKnownWorktreesInListing(store, repo, raw, options)
        expect(rows.map((row) => row.path).sort()).toEqual([repo.path, ...saved].sort())
        expect(rows.filter((row) => row.isMainWorktree).map((row) => row.path)).toEqual([repo.path])
        expect(rows.every((row) => row.branch === 'refs/heads/feature' || row.isMainWorktree)).toBe(
          true
        )
      }
    }
    const mainAlias = join(directory, 'main-alias')
    await symlink(repo.path, mainAlias, 'dir')
    const mainRows = await retainKnownWorktreesInListing(fixture([mainAlias]), repo, raw, options)
    expect(mainRows.filter((row) => row.isMainWorktree).map((row) => row.path)).toEqual([repo.path])
    expect(mainRows.find((row) => row.path === mainAlias)?.isMainWorktree).toBe(false)
    const barePath = join(directory, 'bare')
    git('clone', '--bare', repo.path, barePath)
    const bareAlias = join(directory, 'bare-alias')
    await symlink(barePath, bareAlias, 'dir')
    const bareRows = await retainKnownWorktreesInListing(
      fixture([bareAlias]),
      { ...repo, path: barePath },
      await readWorktreeList(barePath),
      options
    )
    expect(bareRows.map((row) => [row.path, row.isBare, row.isMainWorktree])).toEqual([
      [barePath, true, true],
      [bareAlias, true, false]
    ])
  })

  it('rejects enclosing-repository facts when a nested child loses its marker, and recovers', async () => {
    const child = join(repo.path, 'nested-child')
    git('worktree', 'add', '-b', 'feature', child)
    const main = (await readWorktreeList(repo.path)).filter((row) => row.isMainWorktree)
    const marker = await readFile(join(child, '.git'), 'utf8')
    await unlink(join(child, '.git'))
    expect(
      execFileSync('git', ['-C', child, 'rev-parse', '--verify', 'HEAD'], {
        encoding: 'utf8'
      }).trim()
    ).toBe(git('rev-parse', 'HEAD'))
    await expect(
      retainKnownWorktreesInListing(fixture([child]), repo, main, options)
    ).rejects.toThrow('could not be verified')
    await writeFile(join(child, '.git'), marker)
    expect(
      (await retainKnownWorktreesInListing(fixture([child]), repo, main, options)).find(
        (row) => row.path === child
      )?.branch
    ).toBe('refs/heads/feature')
  })

  it('retains a real prunable registration with an existing directory using raw branch facts', async () => {
    const child = join(directory, 'child')
    git('worktree', 'add', '-b', 'feature', child)
    await unlink(join(child, '.git'))
    const raw = await readWorktreeList(repo.path)
    expect(raw.find((row) => row.path === child)?.prunable).toBe(true)
    const retained = await retainKnownWorktreesInListing(fixture([child]), repo, raw, options)
    expect(retained.find((row) => row.path === child)).toMatchObject({
      prunable: false,
      branch: 'refs/heads/feature'
    })
    await expect(readWorktreeCheckout(child)).rejects.toThrow()
  })

  it('requires a current repo and containing location before accepting an absent child', async () => {
    const child = join(directory, 'external', 'child')
    await mkdir(join(directory, 'external'))
    const raw = await readWorktreeList(repo.path)
    const store = fixture([child])
    expect(
      (await retainKnownWorktreesInListing(store, repo, raw, options)).map((row) => row.path)
    ).toEqual([repo.path])
    await rm(join(directory, 'external'), { recursive: true })
    await expect(retainKnownWorktreesInListing(store, repo, raw, options)).rejects.toThrow(
      'could not be verified'
    )
    await mkdir(join(directory, 'external'))
    await rm(repo.path, { recursive: true })
    await expect(retainKnownWorktreesInListing(store, repo, raw, options)).rejects.toThrow(
      'could not be verified'
    )
  })

  it('declines empty/incomplete listings and nonrepo folders instead of manufacturing detached facts', async () => {
    const child = join(directory, 'not-a-repo')
    await mkdir(child)
    const store = fixture([child])
    await expect(retainKnownWorktreesInListing(store, repo, [], options)).rejects.toThrow(
      'could not be verified'
    )
    await expect(
      retainKnownWorktreesInListing(store, repo, await readWorktreeList(repo.path), options)
    ).rejects.toThrow('could not be verified')
  })

  it('preserves precise WSL tail identities and bypasses other hosts without probing', async () => {
    const upper = String.raw`\\wsl.localhost\Ubuntu\home\Foo`
    const lower = String.raw`\\WSL$\ubuntu\home\foo`
    const raw = [
      {
        path: repo.path,
        head: 'a',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      ...[upper, lower].map((path) => ({
        path,
        head: 'b',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }))
    ]
    expect(
      (await retainKnownWorktreesInListing(fixture([upper, lower]), repo, raw, options)).map(
        (row) => row.path
      )
    ).toEqual([repo.path, upper, lower])
    expect(
      await retainKnownWorktreesInListing(
        fixture([upper]),
        { ...repo, executionHostId: 'ssh:box' },
        [],
        options
      )
    ).toEqual([])
  })
})
