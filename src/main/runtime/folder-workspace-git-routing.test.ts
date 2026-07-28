import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { RpcDispatcher } from './rpc/dispatcher'
import { GIT_METHODS } from './rpc/methods/git'
import type { FolderWorkspace, ProjectGroup, Repo, WorktreeMeta } from '../../shared/types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// Why: a fixed path collides when two runs of this file overlap (watch mode, CI
// shards), and each `buildFixture` rm -rf's the other's repos mid-test.
const FIXTURE = mkdtempSync(join(realpathSync(tmpdir()), 'orca-6357-'))
const CONTAINER = join(FIXTURE, 'fint')
const CHILD_API = join(CONTAINER, 'fint_api')
const CHILD_WT = join(FIXTURE, 'wt-fint_api-refund')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function buildFixture(): void {
  rmSync(FIXTURE, { recursive: true, force: true })
  for (const repo of ['fint_api', 'fint-portal']) {
    const dir = join(CONTAINER, repo)
    mkdirSync(join(dir, 'src'), { recursive: true })
    // Why not `init -b`: that flag lands in git 2.28, above the repo's 2.25 baseline.
    git(dir, 'init', '-q', '.')
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/master')
    git(dir, 'config', 'user.email', 'a@b.c')
    git(dir, 'config', 'user.name', 't')
    writeFileSync(join(dir, 'src', 'app.ts'), 'export {}\n')
    writeFileSync(join(dir, '.eslintrc.json'), '{}\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'init')
    appendFileSync(join(dir, 'src', 'app.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'src', 'new-file.ts'), 'new\n')
  }
  git(CHILD_API, 'worktree', 'add', '-q', '-b', 'feature/refund', CHILD_WT)
  appendFileSync(join(CHILD_WT, 'src', 'app.ts'), 'worktree edit\n')
}

const FOLDER_WS_ID = 'fw-1'
const GROUP_ID = 'pg-1'

function repo(id: string, path: string, kind: 'folder' | 'git'): Repo {
  return { id, path, displayName: id, badgeColor: 'blue', addedAt: 1, kind, connectionId: null }
}

/** Both child repos registered, matching a user who imported the whole container. */
function allRepos(): Repo[] {
  return [
    repo('folder-repo', CONTAINER, 'folder'),
    repo('fint-api-repo', CHILD_API, 'git'),
    repo('fint-portal-repo', join(CONTAINER, 'fint-portal'), 'git')
  ]
}

function makeStore(
  overrides: { repos?: Repo[]; extraFolderWorkspaces?: FolderWorkspace[] } = {}
): unknown {
  const folderRepo: Repo = {
    id: 'folder-repo',
    path: CONTAINER,
    displayName: 'fint',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'folder',
    connectionId: null
  }
  const childRepo: Repo = {
    id: 'fint-api-repo',
    path: CHILD_API,
    displayName: 'fint_api',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git',
    connectionId: null
  }
  const repos = overrides.repos ?? [folderRepo, childRepo]
  const group: ProjectGroup = {
    id: GROUP_ID,
    name: 'fint',
    parentPath: CONTAINER,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const folderWorkspace: FolderWorkspace = {
    id: FOLDER_WS_ID,
    projectGroupId: GROUP_ID,
    name: 'Refund fix',
    folderPath: CONTAINER,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const meta: Record<string, WorktreeMeta> = {}
  return {
    getRepo: (id: string) => repos.find((r) => r.id === id),
    getRepos: () => repos,
    addRepo: () => {},
    updateRepo: (id: string, u: Record<string, unknown>) => ({
      ...repos.find((r) => r.id === id),
      ...u
    }),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: (id: string, patch: Record<string, unknown>) => {
      meta[id] = { ...meta[id], ...patch } as WorktreeMeta
      return meta[id]
    },
    removeWorktreeMeta: () => {},
    getSparsePresets: () => [],
    saveSparsePreset: (p: unknown) => p,
    getGitHubCache: () => undefined,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => [],
    getProjectGroups: () => [group],
    getFolderWorkspaces: () => [folderWorkspace, ...(overrides.extraFolderWorkspaces ?? [])]
  }
}

/** A second workspace record over the same container path — the shape a shared path takes. */
function siblingFolderWorkspace(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: GROUP_ID,
    name: 'Refund fix (other host)',
    folderPath: CONTAINER,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('#6357 monorepo folder workspace', () => {
  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  it('A: file explorer resolves for a folder workspace (merged #6569 path)', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    const entries = await runtime.readFileExplorerDir(selector, 'fint_api/src')
    expect(entries.map((e) => e.name).sort()).toContain('app.ts')
  })

  it('B: git status lists changes from every child repo, workspace-relative', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    const status = await runtime.getRuntimeGitStatus(selector)
    const paths = status.entries.map((entry) => entry.path).sort()
    expect(paths).toEqual([
      'fint-portal/src/app.ts',
      'fint-portal/src/new-file.ts',
      'fint_api/src/app.ts',
      'fint_api/src/new-file.ts'
    ])
    // Why: no single HEAD describes N repos, so the merge must not claim one.
    expect(status.head).toBeUndefined()
    expect(status.branch).toBeUndefined()
  })

  it('C: git diff for the SAME folder-workspace selector resolves the owning child repo', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    const diff = await runtime.getRuntimeGitDiff(selector, 'fint_api/src/app.ts', false)
    expect(JSON.stringify(diff)).toContain('export const x = 1')
  })

  it('C2: a workspace-relative path escaping the folder does not resolve to another repo', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    const caught = await runtime
      .getRuntimeGitDiff(selector, '../wt-fint_api-refund/src/app.ts', false)
      .then(() => null)
      .catch((err: unknown) => String(err))
    // Rejected by relative-path normalization before routing ever sees it.
    expect(caught).toContain('invalid_relative_path')
  })

  it('D: the folder REPO placeholder selector still reports an empty, non-repo status', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore() as never)
    // The folder repo's placeholder worktree points at the container, which is not a
    // git repo. Unchanged by this fix; the folder-WORKSPACE selector is the fixed path.
    const status = await runtime.getRuntimeGitStatus(`id:folder-repo::${CONTAINER}`)
    expect(status.entries).toEqual([])
  })

  it('F: the RPC surface the renderer actually calls succeeds end to end', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`

    const diffResponse = await dispatcher.dispatch({
      id: 'r1',
      authToken: 'tok',
      method: 'git.diff',
      params: { worktree: selector, filePath: 'fint_api/src/app.ts', staged: false }
    })
    const statusResponse = await dispatcher.dispatch({
      id: 'r2',
      authToken: 'tok',
      method: 'git.status',
      params: { worktree: selector }
    })
    expect(diffResponse).toMatchObject({ ok: true })
    expect(statusResponse).toMatchObject({ ok: true })
    // Why: status must list a path that git.diff can then resolve — the two
    // surfaces have to agree on the same addressing scheme.
    const listed = (statusResponse as { result: { entries: { path: string }[] } }).result.entries
    expect(listed.map((entry) => entry.path)).toContain('fint_api/src/app.ts')
  })

  it('H: every file status lists can then be staged, unstaged and discarded', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    // Why: listing a file the user then cannot act on is worse than listing nothing.
    for (const entry of (await runtime.getRuntimeGitStatus(selector)).entries) {
      await runtime.stageRuntimeGitPath(selector, entry.path)
    }
    const staged = await runtime.getRuntimeGitStatus(selector)
    expect(staged.entries.every((entry) => entry.area === 'staged')).toBe(true)

    await runtime.unstageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    const unstaged = await runtime.getRuntimeGitStatus(selector)
    expect(unstaged.entries.find((entry) => entry.path === 'fint_api/src/app.ts')?.area).toBe(
      'unstaged'
    )

    await runtime.discardRuntimeGitPath(selector, 'fint_api/src/app.ts')
    const discarded = await runtime.getRuntimeGitStatus(selector)
    expect(discarded.entries.map((entry) => entry.path)).not.toContain('fint_api/src/app.ts')
  })

  it('I: a bulk request spanning two child repos stages every path in both', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.bulkStageRuntimeGitPaths(selector, [
      'fint_api/src/app.ts',
      'fint-portal/src/app.ts',
      'fint-portal/src/new-file.ts'
    ])
    const status = await runtime.getRuntimeGitStatus(selector)
    const stagedPaths = status.entries
      .filter((entry) => entry.area === 'staged')
      .map((entry) => entry.path)
      .sort()
    expect(stagedPaths).toEqual([
      'fint-portal/src/app.ts',
      'fint-portal/src/new-file.ts',
      'fint_api/src/app.ts'
    ])
  })

  it('J: a bulk request naming a path no child repo owns fails instead of partially applying', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    const caught = await runtime
      .bulkStageRuntimeGitPaths(selector, ['fint_api/src/app.ts', 'not-a-repo/x.ts'])
      .then(() => null)
      .catch((err: unknown) => String(err))
    expect(caught).toContain('selector_not_found')
    // Why: the whole batch must be rejected before any repo is mutated.
    const status = await runtime.getRuntimeGitStatus(selector)
    expect(status.entries.every((entry) => entry.area !== 'staged')).toBe(true)
  })

  it('K: commit routes to the one child repo that has a staged index', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    const portal = join(CONTAINER, 'fint-portal')
    // Why: staging only one repo is the common case — the user edited one project.
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    await expect(runtime.commitRuntimeGit(selector, 'only api')).resolves.toEqual({ success: true })
    expect(git(CHILD_API, 'log', '-1', '--pretty=%s').trim()).toBe('only api')
    expect(git(portal, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })

  it('K2: staging across two repos is refused before either is committed', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.bulkStageRuntimeGitPaths(selector, [
      'fint_api/src/app.ts',
      'fint-portal/src/app.ts'
    ])
    // Why: git has no cross-repo transaction. Committing repo 1 then failing on
    // repo 2 leaves a half-done commit that `{ success, error }` cannot describe
    // and the user cannot undo from the UI — so refuse before mutating anything.
    const result = await runtime.commitRuntimeGit(selector, 'span two repos')
    expect(result.success).toBe(false)
    expect(result.error).toContain('fint-api-repo')
    expect(result.error).toContain('fint-portal-repo')
    for (const dir of [CHILD_API, join(CONTAINER, 'fint-portal')]) {
      expect(git(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    }
  })

  it('K5: a child repo that cannot be inspected fails the commit instead of committing around it', async () => {
    buildFixture()
    // Why: the repo we cannot read could be the one the user staged. Committing
    // the others and reporting success is how a staged file is silently skipped.
    const unreadable = join(CONTAINER, 'fint-detached')
    mkdirSync(unreadable, { recursive: true })
    const runtime = new OrcaRuntimeService(
      makeStore({ repos: [...allRepos(), repo('fint-detached-repo', unreadable, 'git')] }) as never
    )
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    const result = await runtime.commitRuntimeGit(selector, 'api only')
    expect(result.success).toBe(false)
    expect(result.error).toContain('fint-detached-repo')
    expect(git(CHILD_API, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })

  it('K3: committing with nothing staged anywhere reports it instead of silently succeeding', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await expect(runtime.commitRuntimeGit(selector, 'nothing here')).resolves.toEqual({
      success: false,
      error: 'nothing to commit'
    })
  })

  it('K4: an empty message is rejected for a folder workspace too', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    // Why: routing around the single-repo path must not drop its validation.
    await expect(runtime.commitRuntimeGit(selector, '   ')).rejects.toThrow(
      'Commit message is required'
    )
  })

  it('L: abort targets only the child repo actually mid-merge', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    // Build a real conflicting merge in one child repo only.
    git(CHILD_API, 'checkout', '-q', '--', '.')
    git(CHILD_API, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(CHILD_API, 'src', 'app.ts'), 'other branch\n')
    git(CHILD_API, 'commit', '-qam', 'other')
    git(CHILD_API, 'checkout', '-q', 'master')
    writeFileSync(join(CHILD_API, 'src', 'app.ts'), 'master branch\n')
    git(CHILD_API, 'commit', '-qam', 'master')
    expect(() => git(CHILD_API, 'merge', 'other')).toThrow()
    expect(await runtime.getRuntimeGitConflictOperation(`path:${CHILD_API}`)).toBe('merge')

    await expect(runtime.abortRuntimeGitMerge(selector)).resolves.toEqual({ ok: true })
    expect(await runtime.getRuntimeGitConflictOperation(`path:${CHILD_API}`)).toBe('unknown')
  })

  it('L2: aborting when no child repo is mid-operation says so instead of reporting ok', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    // Why: a single repo's `git merge --abort` errors with no merge in progress.
    // Returning ok here would be the only path where the user is told a conflict
    // was cleared that never existed.
    await expect(runtime.abortRuntimeGitMerge(selector)).rejects.toThrow(
      'No repository in this workspace has a merge in progress.'
    )
    await expect(runtime.abortRuntimeGitRebase(selector)).rejects.toThrow(
      'No repository in this workspace has a rebase in progress.'
    )
  })

  it('L3: a failed abort propagates rather than reporting ok on a still-conflicted repo', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    git(CHILD_API, 'checkout', '-q', '--', '.')
    git(CHILD_API, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(CHILD_API, 'src', 'app.ts'), 'other branch\n')
    git(CHILD_API, 'commit', '-qam', 'other')
    git(CHILD_API, 'checkout', '-q', 'master')
    writeFileSync(join(CHILD_API, 'src', 'app.ts'), 'master branch\n')
    git(CHILD_API, 'commit', '-qam', 'master')
    expect(() => git(CHILD_API, 'merge', 'other')).toThrow()
    // Why: a terminal running git in the same repo holds index.lock, and the
    // abort fails against it. The repo stays conflicted, so the user must not be
    // told the conflict was cleared.
    writeFileSync(join(CHILD_API, '.git', 'index.lock'), '')
    await expect(runtime.abortRuntimeGitMerge(selector)).rejects.toThrow()
    rmSync(join(CHILD_API, '.git', 'index.lock'), { force: true })
    expect(await runtime.getRuntimeGitConflictOperation(`path:${CHILD_API}`)).toBe('merge')
  })

  it('L4: two child repos mid-merge is refused rather than aborting an arbitrary one', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    for (const dir of [CHILD_API, join(CONTAINER, 'fint-portal')]) {
      git(dir, 'checkout', '-q', '--', '.')
      git(dir, 'checkout', '-q', '-b', 'other')
      writeFileSync(join(dir, 'src', 'app.ts'), 'other branch\n')
      git(dir, 'commit', '-qam', 'other')
      git(dir, 'checkout', '-q', 'master')
      writeFileSync(join(dir, 'src', 'app.ts'), 'master branch\n')
      git(dir, 'commit', '-qam', 'master')
      expect(() => git(dir, 'merge', 'other')).toThrow()
    }
    await expect(runtime.abortRuntimeGitMerge(selector)).rejects.toThrow('More than one repository')
    // Why: neither may be aborted — the user picked no repo, so we pick none.
    for (const dir of [CHILD_API, join(CONTAINER, 'fint-portal')]) {
      expect(await runtime.getRuntimeGitConflictOperation(`path:${dir}`)).toBe('merge')
    }
    // Why: with two conflicts there is no single workspace-level answer either.
    expect((await runtime.getRuntimeGitStatus(selector)).conflictOperation).toBe('unknown')
  })

  it('M: commit-message generation routes to the same child repo the commit would', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    // Why: before routing, this threw `selector_not_found` — the mobile commit
    // screen's Generate button was dead for every folder workspace. Stub the
    // single-repo implementation so the assertion is about which selector it is
    // handed, not about reaching a drafting model.
    const inner = vi
      .spyOn(
        runtime['gitCommands'] as { generateRuntimeCommitMessage: (...args: never[]) => unknown },
        'generateRuntimeCommitMessage'
      )
      .mockResolvedValue({ success: true, message: 'drafted' } as never)
    await expect(runtime.generateRuntimeCommitMessage(selector)).resolves.toEqual({
      success: true,
      message: 'drafted'
    })
    const routedSelector = String(inner.mock.calls[0]?.[0])
    expect(routedSelector).not.toBe(selector)
    // Why: the child repo's own worktree id — the same target the commit picks.
    const commitTarget = await runtime.getRuntimeGitStatus(routedSelector)
    expect(commitTarget.entries.map((entry) => entry.path)).toContain('src/app.ts')
    inner.mockRestore()
  })

  it('M2: generation reports no staged changes rather than a resolution error', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    const result = await runtime.generateRuntimeCommitMessage(selector)
    expect(result).toEqual({ success: false, error: 'No staged changes to summarize.' })
  })

  it('K6: a child repo with a corrupt index fails the commit instead of committing around it', async () => {
    buildFixture()
    const portal = join(CONTAINER, 'fint-portal')
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    // Why: `getStatus` catches a failed git read and resolves an EMPTY result, so a
    // repo whose index cannot be parsed looks exactly like a clean one. Selecting on
    // that reading commits a different repo and reports success — the corrupt repo
    // could be the one the user staged. K5 covers an unresolvable target; this covers
    // a resolvable target with an unreadable index, which took a different code path.
    writeFileSync(join(portal, '.git', 'index'), 'not an index')
    const result = await runtime.commitRuntimeGit(selector, 'api only')
    expect(result.success).toBe(false)
    expect(result.error).toContain('fint-portal-repo')
    expect(git(CHILD_API, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })

  it('K7: a staged file sorting past the status entry cap is still seen as staged', async () => {
    buildFixture()
    const portal = join(CONTAINER, 'fint-portal')
    git(CHILD_API, 'checkout', '-q', '--', '.')
    rmSync(join(CHILD_API, 'src', 'new-file.ts'), { force: true })
    // Why: `getStatus` stops at DEFAULT_GIT_STATUS_LIMIT (1000) entries. Git emits
    // porcelain rows in path order, so >1000 merely-modified files sorting ahead of
    // the staged one push it past the cap — the staged row never reaches the caller
    // and the repo reads as clean. The commit then goes to a different child repo and
    // reports success. The probe asks git a yes/no question, which has no cap.
    mkdirSync(join(portal, 'bulk'), { recursive: true })
    for (let index = 0; index < 1200; index += 1) {
      writeFileSync(join(portal, 'bulk', `aaa-${String(index).padStart(4, '0')}.ts`), 'export {}\n')
    }
    writeFileSync(join(portal, 'zzz-staged.ts'), 'export const staged = 1\n')
    git(portal, 'add', '-A')
    git(portal, 'commit', '-qm', 'bulk baseline')
    for (let index = 0; index < 1200; index += 1) {
      writeFileSync(join(portal, 'bulk', `aaa-${String(index).padStart(4, '0')}.ts`), 'edited\n')
    }
    writeFileSync(join(portal, 'zzz-staged.ts'), 'export const staged = 2\n')
    git(portal, 'add', 'zzz-staged.ts')
    // Guard the premise: the staged row really is past the cap, so this test would
    // pass for the wrong reason if the fixture ever stopped exceeding it.
    const rows = git(portal, 'status', '--porcelain=v2', '--untracked-files=all').split('\n')
    expect(rows.findIndex((row) => row.includes('zzz-staged.ts'))).toBeGreaterThan(1000)
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await expect(runtime.commitRuntimeGit(selector, 'bulk portal')).resolves.toEqual({
      success: true
    })
    expect(git(portal, 'log', '-1', '--pretty=%s').trim()).toBe('bulk portal')
    expect(git(CHILD_API, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })

  it('L5: an unreadable child repo fails the abort instead of aborting a different one', async () => {
    buildFixture()
    const portal = join(CONTAINER, 'fint-portal')
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    git(CHILD_API, 'checkout', '-q', '--', '.')
    git(CHILD_API, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(CHILD_API, 'src', 'app.ts'), 'other branch\n')
    git(CHILD_API, 'commit', '-qam', 'other')
    git(CHILD_API, 'checkout', '-q', 'master')
    writeFileSync(join(CHILD_API, 'src', 'app.ts'), 'master branch\n')
    git(CHILD_API, 'commit', '-qam', 'master')
    expect(() => git(CHILD_API, 'merge', 'other')).toThrow()
    // Why: an unreadable repo reads as merely un-conflicted, so the abort would go to
    // the one repo we CAN read — which may not be the one the user is looking at.
    writeFileSync(join(portal, '.git', 'index'), 'not an index')
    await expect(runtime.abortRuntimeGitMerge(selector)).rejects.toThrow('fint-portal-repo')
    expect(await runtime.getRuntimeGitConflictOperation(`path:${CHILD_API}`)).toBe('merge')
  })

  /**
   * Hold a folder-workspace generation open so cancellation has a real in-flight
   * lane to act on, and record every child selector cancellation is routed to.
   */
  async function withInFlightGeneration(
    runtime: OrcaRuntimeService,
    selector: string
  ): Promise<{
    generateSelectors: () => string[]
    cancelSelectors: () => string[]
    settle: () => Promise<void>
  }> {
    let release = (): void => {}
    const generate = vi
      .spyOn(
        runtime['gitCommands'] as { generateRuntimeCommitMessage: (...args: never[]) => unknown },
        'generateRuntimeCommitMessage'
      )
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ success: true, message: 'drafted' })
          }) as never
      )
    const cancel = vi
      .spyOn(
        runtime['gitCommands'] as {
          cancelRuntimeGenerateCommitMessage: (...args: never[]) => unknown
        },
        'cancelRuntimeGenerateCommitMessage'
      )
      .mockResolvedValue({ ok: true } as never)
    const inFlight = runtime.generateRuntimeCommitMessage(selector)
    await vi.waitFor(() => expect(generate).toHaveBeenCalled())
    return {
      generateSelectors: () => generate.mock.calls.map((call) => String(call[0])),
      cancelSelectors: () => cancel.mock.calls.map((call) => String(call[0])),
      settle: async () => {
        release()
        await inFlight
        generate.mockRestore()
        cancel.mockRestore()
      }
    }
  }

  it('M3: cancelling generation reaches the child repo instead of dying on the folder selector', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    // Why: generation re-enters by the child's selector, so its cancel lane is keyed
    // to the child path. Passing the folder selector straight through threw
    // `selector_not_found`, and every caller is fire-and-forget — so Cancel silently
    // did nothing and the draft kept running.
    const run = await withInFlightGeneration(runtime, selector)
    await expect(runtime.cancelRuntimeGenerateCommitMessage(selector)).resolves.toEqual({
      ok: true
    })
    const routed = run.cancelSelectors()
    expect(routed).not.toContain(selector)
    // Why: exactly the lane the generation started under — see M4 for why not more.
    expect(routed).toEqual(run.generateSelectors())
    const staged = await runtime.getRuntimeGitStatus(routed[0] as string)
    expect(staged.entries.length).toBeGreaterThan(0)
    await run.settle()
  })

  it('M4: cancelling one child repo leaves a sibling repo untouched', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    // Why: cancellation is keyed by cwd alone, with no notion of who asked. Signalling
    // every child — which is what routing Cancel by a fresh staged-repo *re-selection*
    // amounts to — kills a draft the user started from the sibling repo's own view.
    // The renderer keeps generation per-worktree precisely so navigating away does not
    // cancel it (SourceControl.tsx), so that concurrent draft is reachable, not theoretical.
    // Markers unique to each child, so a routed selector can be named by repo.
    writeFileSync(join(CHILD_API, 'src', 'only-in-api.ts'), 'marker\n')
    writeFileSync(join(CONTAINER, 'fint-portal', 'src', 'only-in-portal.ts'), 'marker\n')
    const run = await withInFlightGeneration(runtime, selector)
    await runtime.cancelRuntimeGenerateCommitMessage(selector)
    const routed = run.cancelSelectors()
    const signalled = await Promise.all(
      routed.map(async (target) =>
        (await runtime.getRuntimeGitStatus(target)).entries.map((entry) => entry.path)
      )
    )
    // Before this, Cancel fanned out to every child, so the sibling was signalled too.
    expect(signalled.flat()).toContain('src/only-in-api.ts')
    expect(signalled.flat()).not.toContain('src/only-in-portal.ts')
    expect(routed).toHaveLength(1)
    await run.settle()
  })

  it('M5: Cancel with nothing in flight signals no child at all', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    const cancel = vi
      .spyOn(
        runtime['gitCommands'] as {
          cancelRuntimeGenerateCommitMessage: (...args: never[]) => unknown
        },
        'cancelRuntimeGenerateCommitMessage'
      )
      .mockResolvedValue({ ok: true } as never)
    // Why: a stale Cancel click (the draft already finished) must not become a
    // remote kill switch for whatever is running in these repos now.
    await expect(runtime.cancelRuntimeGenerateCommitMessage(selector)).resolves.toEqual({
      ok: true
    })
    expect(cancel).not.toHaveBeenCalled()
    cancel.mockRestore()
  })

  it('M6: a settled generation does not clear the lane of one still running in the same child', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore({ repos: allRepos() }) as never)
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    // Two clients (two windows on the same workspace) generate into the same child.
    const releases: (() => void)[] = []
    const generate = vi
      .spyOn(
        runtime['gitCommands'] as { generateRuntimeCommitMessage: (...args: never[]) => unknown },
        'generateRuntimeCommitMessage'
      )
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ success: true, message: 'drafted' }))
          }) as never
      )
    const cancel = vi
      .spyOn(
        runtime['gitCommands'] as {
          cancelRuntimeGenerateCommitMessage: (...args: never[]) => unknown
        },
        'cancelRuntimeGenerateCommitMessage'
      )
      .mockResolvedValue({ ok: true } as never)
    const both = [
      runtime.generateRuntimeCommitMessage(selector),
      runtime.generateRuntimeCommitMessage(selector)
    ]
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    // Release one and await the race, not a named handle: both generations resolve their
    // target concurrently, so which one reaches the spy first is not ordered. `finally`
    // runs before the outer promise settles, so this pins "one has fully released its lane".
    releases[0]?.()
    await Promise.race(both)
    // Why: a Set keyed by selector loses multiplicity, so that one `finally` deleted the
    // lane and left the other draft with no way to be cancelled at all.
    await runtime.cancelRuntimeGenerateCommitMessage(selector)
    expect(cancel).toHaveBeenCalledTimes(1)
    releases[1]?.()
    await Promise.all(both)
    // Both settled: the refcount must reach zero rather than stranding a lane at 1.
    expect((runtime['folderWorkspaceCommitMessageLanes'] as Map<string, unknown>).size).toBe(0)
    generate.mockRestore()
    cancel.mockRestore()
  })

  it('M7: Cancel from a workspace sharing the container path leaves the other one running', async () => {
    buildFixture()
    const OTHER_WS_ID = 'fw-2'
    const runtime = new OrcaRuntimeService(
      makeStore({
        repos: allRepos(),
        extraFolderWorkspaces: [siblingFolderWorkspace(OTHER_WS_ID)]
      }) as never
    )
    const selector = `id:${folderWorkspaceKey(FOLDER_WS_ID)}`
    await runtime.stageRuntimeGitPath(selector, 'fint_api/src/app.ts')
    // Why: two workspace records can name the same container — the same POSIX path on two
    // SSH hosts is the reachable case. Keyed by that path they collapse into one lane
    // entry, so a Cancel arriving for one resolves the *other's* recorded child selector
    // and kills a draft its user never cancelled.
    const run = await withInFlightGeneration(runtime, selector)
    await runtime.cancelRuntimeGenerateCommitMessage(`id:${folderWorkspaceKey(OTHER_WS_ID)}`)
    // The other workspace has nothing in flight, so it must signal no child at all.
    expect(run.cancelSelectors()).toEqual([])
    // ...and the first workspace's lane survives to be cancelled by its own owner.
    await runtime.cancelRuntimeGenerateCommitMessage(selector)
    expect(run.cancelSelectors()).toEqual(run.generateSelectors())
    await run.settle()
    expect((runtime['folderWorkspaceCommitMessageLanes'] as Map<string, unknown>).size).toBe(0)
  })

  it('E: the real child git worktree resolves fine when its repo is registered', async () => {
    buildFixture()
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const status = await runtime.getRuntimeGitStatus(`path:${CHILD_WT}`)
    expect(status.entries.map((entry) => entry.path)).toContain('src/app.ts')
    expect(status.branch).toBe('refs/heads/feature/refund')
  })
})
