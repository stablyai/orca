import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { parseRepoRelinkError } from '../../shared/repo-path-status'
import { closeTestStores, createStore, makeRepo, testState } from '../persistence-test-harness'
import { makeTerminalTab } from '../persistence-session-fixtures'
import { hashWorktreeId } from '../terminal-history-id'
import { copyShellHistoryForRenamedWorktree } from '../repo-relink/shell-history-relink'
import { RuntimeRepositoryRelinkController } from './runtime-repository-relink-controller'

let workspace = ''
let historyRoot = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    // A missing file is an empty global config on every platform, so signing hooks stay out.
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(workspace, 'no-global-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1'
    }
  })
}

function createCheckout(path: string, remote: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q')
  git(path, 'config', 'user.email', 'relink@test.local')
  git(path, 'config', 'user.name', 'Relink Test')
  writeFileSync(join(path, 'README.md'), '# app\n')
  git(path, 'add', 'README.md')
  git(path, 'commit', '-q', '-m', 'init')
  git(path, 'remote', 'add', 'origin', remote)
}

function controllerFor(store: ReturnType<typeof createStore>) {
  const deps = {
    getStore: () => store,
    resolveRepo: async (selector: string) => {
      const repo = store.getRepos().find((candidate) => candidate.id === selector)
      if (!repo) {
        throw new Error('repo_not_found')
      }
      return repo
    },
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyWorktreeFolderRenamed: vi.fn(),
    notifyReposChanged: vi.fn(),
    copyShellHistory: (oldId: string, newId: string) =>
      copyShellHistoryForRenamedWorktree(oldId, newId, [historyRoot])
  }
  return { controller: new RuntimeRepositoryRelinkController(deps), deps }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-relink-store-'))
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'orca-relink-repo-')))
  historyRoot = join(workspace, 'terminal-history')
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

describe('RuntimeRepositoryRelinkController', () => {
  it('relinks a moved repo and carries meta, session tabs and shell history to the new id', async () => {
    const oldPath = join(workspace, 'app')
    const newPath = join(workspace, 'moved', 'app')
    createCheckout(oldPath, 'git@example.com:team/app.git')
    const store = createStore()
    store.addRepo(
      makeRepo({
        id: 'repo-1',
        path: oldPath,
        displayName: 'app',
        gitRemoteIdentity: {
          canonicalKey: 'example.com/team/app',
          remoteName: 'origin',
          remoteUrl: 'git@example.com:team/app.git'
        }
      })
    )
    const oldId = `repo-1::${oldPath}`
    const newId = `repo-1::${newPath}`
    store.setWorktreeMetaForHost(oldId, 'local', { comment: 'keep me', displayName: 'Main' })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-1',
      activeWorktreeId: oldId,
      tabsByWorktree: {
        [oldId]: [makeTerminalTab({ id: 'tab-1', ptyId: `${oldId}@@abcd1234`, worktreeId: oldId })]
      }
    })
    mkdirSync(join(historyRoot, hashWorktreeId(oldId)), { recursive: true })
    writeFileSync(join(historyRoot, hashWorktreeId(oldId), 'zsh_history'), 'echo hi\n')

    mkdirSync(join(workspace, 'moved'))
    renameSync(oldPath, newPath)
    const { controller, deps } = controllerFor(store)
    const result = await controller.relink('repo-1', newPath)

    expect(result.evidence).toBe('remote-identity')
    expect(result.repo.path).toBe(newPath)
    expect(store.getRepo('repo-1')?.path).toBe(newPath)
    expect(store.getWorktreeMetaForHost(newId, 'local')).toMatchObject({
      comment: 'keep me',
      displayName: 'Main'
    })
    expect(store.getWorktreeMetaForHost(oldId, 'local')).toBeUndefined()
    const session = store.getWorkspaceSession('local')
    expect(session.activeWorktreeId).toBe(newId)
    expect(session.tabsByWorktree[oldId]).toBeUndefined()
    // The PTY session id keeps its old prefix, so its scrollback directory still resolves.
    expect(session.tabsByWorktree[newId]).toEqual([
      expect.objectContaining({ id: 'tab-1', ptyId: `${oldId}@@abcd1234`, worktreeId: newId })
    ])
    expect(readFileSync(join(historyRoot, hashWorktreeId(newId), 'zsh_history'), 'utf8')).toBe(
      'echo hi\n'
    )
    expect(existsSync(join(historyRoot, hashWorktreeId(oldId), 'zsh_history'))).toBe(true)
    expect(deps.notifyWorktreeFolderRenamed).toHaveBeenCalledWith('repo-1', oldId, newId)
    expect(deps.notifyReposChanged).toHaveBeenCalled()

    store.flush()
    const reloaded = createStore()
    expect(reloaded.getRepo('repo-1')?.path).toBe(newPath)
    expect(reloaded.getWorktreeMetaForHost(newId, 'local')?.comment).toBe('keep me')
  })

  it.skipIf(process.platform === 'win32')(
    'accepts the target of a symlink left at the old path without a remote',
    async () => {
      const oldPath = join(workspace, 'app')
      const newPath = join(workspace, 'disk2', 'app')
      createCheckout(oldPath, 'git@example.com:team/app.git')
      git(oldPath, 'remote', 'remove', 'origin')
      const store = createStore()
      store.addRepo(makeRepo({ id: 'repo-1', path: oldPath, gitRemoteIdentity: null }))
      mkdirSync(join(workspace, 'disk2'))
      renameSync(oldPath, newPath)
      symlinkSync(newPath, oldPath)
      const { controller } = controllerFor(store)
      const statuses = await controller.listPathStatuses()
      expect(statuses).toEqual([
        expect.objectContaining({ repoId: 'repo-1', status: { state: 'moved', target: newPath } })
      ])
      const result = await controller.relink('repo-1', newPath)
      expect(result.evidence).toBe('path-alias')
      expect(store.getRepo('repo-1')?.path).toBe(newPath)
    }
  )

  it('re-keys a nested linked worktree git lists at the new location and reports stale ones', async () => {
    const oldPath = join(workspace, 'app')
    const newPath = join(workspace, 'moved', 'app')
    createCheckout(oldPath, 'git@example.com:team/app.git')
    git(oldPath, 'remote', 'remove', 'origin')
    git(oldPath, 'worktree', 'add', '-q', '-b', 'nested', join(oldPath, '.worktrees', 'nested'))
    git(oldPath, 'worktree', 'add', '-q', '-b', 'stale', join(oldPath, '.worktrees', 'stale'))
    const outside = join(workspace, 'outside')
    git(oldPath, 'worktree', 'add', '-q', '-b', 'outside', outside)
    const store = createStore()
    store.addRepo(makeRepo({ id: 'repo-1', path: oldPath, gitRemoteIdentity: null }))
    const id = (path: string) => `repo-1::${path}`
    store.setWorktreeMetaForHost(id(join(oldPath, '.worktrees', 'nested')), 'local', {
      displayName: 'Nested'
    })
    store.setWorktreeMetaForHost(id(join(oldPath, '.worktrees', 'stale')), 'local', {
      displayName: 'Stale'
    })
    store.setWorktreeMetaForHost(id(outside), 'local', { displayName: 'Outside' })
    mkdirSync(join(workspace, 'moved'))
    renameSync(oldPath, newPath)
    // A user who ran `git worktree repair` for one nested worktree; the other still has Git's old path.
    git(newPath, 'worktree', 'repair', join(newPath, '.worktrees', 'nested'), outside)

    const { controller } = controllerFor(store)
    const result = await controller.relink('repo-1', newPath)

    // The outside worktree is administered by this common dir, which proves the repository.
    expect(result.evidence).toBe('shared-worktrees')
    expect(result.staleLinkedWorktreeCount).toBe(1)
    expect(
      store.getWorktreeMetaForHost(id(join(newPath, '.worktrees', 'nested')), 'local')?.displayName
    ).toBe('Nested')
    expect(
      store.getWorktreeMetaForHost(id(join(oldPath, '.worktrees', 'stale')), 'local')?.displayName
    ).toBe('Stale')
    expect(store.getWorktreeMetaForHost(id(outside), 'local')?.displayName).toBe('Outside')
  })

  it('refuses another repository and leaves every record untouched', async () => {
    const oldPath = join(workspace, 'app')
    const otherPath = join(workspace, 'other')
    createCheckout(oldPath, 'git@example.com:team/app.git')
    createCheckout(otherPath, 'git@example.com:team/other.git')
    const store = createStore()
    store.addRepo(
      makeRepo({
        id: 'repo-1',
        path: oldPath,
        gitRemoteIdentity: {
          canonicalKey: 'example.com/team/app',
          remoteName: 'origin',
          remoteUrl: 'git@example.com:team/app.git'
        }
      })
    )
    store.setWorktreeMetaForHost(`repo-1::${oldPath}`, 'local', { comment: 'still here' })
    const { controller, deps } = controllerFor(store)
    let message = ''
    await controller.relink('repo-1', otherPath).catch((error: Error) => {
      message = error.message
    })
    expect(parseRepoRelinkError(message)?.code).toBe('repo_relink_different_repository')
    expect(store.getRepo('repo-1')?.path).toBe(oldPath)
    expect(store.getWorktreeMetaForHost(`repo-1::${oldPath}`, 'local')?.comment).toBe('still here')
    expect(deps.notifyReposChanged).not.toHaveBeenCalled()
  })

  it('never moves a repo through the settings write, even when a raw path slips in', () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'repo-1', path: '/old/app' }))
    const updates = { displayName: 'renamed' }
    // Types are erased across IPC, so the write must drop a `path` it was never meant to take.
    Reflect.set(updates, 'path', '/elsewhere')
    store.updateRepo('repo-1', updates)
    expect(store.getRepo('repo-1')).toMatchObject({ path: '/old/app', displayName: 'renamed' })
    expect(store.setRepoPathForHost('repo-1', 'local', '/new/app')?.path).toBe('/new/app')
    expect(store.setRepoPathForHost('repo-1', 'ssh:other', '/x')).toBeNull()
  })

  it('reports a missing checkout and one that is no longer a Git top level', async () => {
    const gone = join(workspace, 'gone')
    const plain = join(workspace, 'plain')
    mkdirSync(plain)
    const store = createStore()
    store.addRepo(makeRepo({ id: 'gone', path: gone }))
    store.addRepo(makeRepo({ id: 'plain', path: plain }))
    const { controller } = controllerFor(store)
    const statuses = await controller.listPathStatuses({ force: true })
    expect(statuses.map((entry) => [entry.repoId, entry.status])).toEqual([
      ['gone', { state: 'missing', reason: 'not-found' }],
      ['plain', { state: 'missing', reason: 'not-git-root' }]
    ])
  })
})
