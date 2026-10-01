import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type { Store } from './persistence'

const { workspaceRoot } = vi.hoisted(() => ({ workspaceRoot: { value: '' } }))
vi.mock('./ipc/worktree-logic', () => ({
  computeWorkspaceRootAsync: async () => workspaceRoot.value,
  getWorktreePathSettings: () => ({})
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({}),
  getWorktreeMirrorDistro: () => undefined
}))

import { addWorktree } from './git/worktree-add'
import {
  _resetSparePoolForTests,
  findSpare,
  spareRepoKey
} from './worktree-create-preparation-pool'
import {
  beginWorktreeCreateSpareRequest,
  requestWorktreeCreateSpare,
  SPARE_REQUEST_DEBOUNCE_MS
} from './worktree-create-preparation'
import { _resetSpareGateForTests } from './worktree-create-spare-gate'

function requestSpareFor(store: Store, target: Repo, base: string): void {
  const ticket = beginWorktreeCreateSpareRequest(store, target)
  if (!ticket) {
    throw new Error('a local repo always gets a spare request ticket')
  }
  requestWorktreeCreateSpare(store, target, base, ticket)
}

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

afterEach(async () => {
  _resetSparePoolForTests()
  _resetSpareGateForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Local `main` one commit behind `origin/main`, as after a fetch the user never merged. */
async function createCloneBehindOrigin(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-spare-commit-')))
  roots.push(root)
  const origin = join(root, 'origin')
  git(root, ['init', '--quiet', origin])
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const commit = async (name: string): Promise<void> => {
    await writeFile(join(origin, name), `${name}\n`)
    git(origin, ['add', name])
    git(origin, ['-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '--quiet', '-m', name])
  }
  await commit('one.txt')
  const repoPath = join(root, 'repo')
  git(root, ['clone', '--quiet', origin, repoPath])
  await commit('two.txt')
  git(repoPath, ['fetch', '--quiet', 'origin'])
  workspaceRoot.value = join(root, 'workspaces')
  return repoPath
}

it('builds the spare at the commit a plain add of the same base uses', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request reads only getSettings, and both Store readers it calls are mocked above.
  const store = { getSettings: () => ({}) } as unknown as Store
  const repoPath = await createCloneBehindOrigin()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local repo needs only id and path on this path; no connectionId, not a folder.
  const repo = { id: 'repo', path: repoPath } as unknown as Repo
  for (const base of ['main', 'origin/main']) {
    _resetSpareGateForTests()
    requestSpareFor(store, repo, base)
    await new Promise((resolve) => setTimeout(resolve, SPARE_REQUEST_DEBOUNCE_MS))
    await vi.waitFor(() => expect(findSpare(spareRepoKey(repoPath))?.state).toBe('ready'), {
      timeout: 20_000
    })
    const plainPath = join(workspaceRoot.value, `plain-${base.replace('/', '-')}`)
    await addWorktree(repoPath, plainPath, `plain-${base.replace('/', '-')}`, base)

    expect(findSpare(spareRepoKey(repoPath))?.oid).toBe(git(plainPath, ['rev-parse', 'HEAD']))
  }
  expect(git(repoPath, ['rev-parse', 'main'])).not.toBe(git(repoPath, ['rev-parse', 'origin/main']))
}, 60_000)
