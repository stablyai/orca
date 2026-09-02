import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeFileCommands } from './orca-runtime-files'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcResponse } from './rpc/core'
import { FILE_METHODS } from './rpc/methods/files'
import { REPOSITORY_ADMIN_PATH_DENIED_MESSAGE } from '../../shared/repository-admin-path'
import { listedWorktrees } from './repository-admin-path-worktree-mock'

/** Mutable across tests, so it lives on one object both suites can reassign. */
export const fixture: {
  repoPath: string
  connectionId: string | undefined
  pathOverride: string | undefined
  sshGeneration: number | undefined
} = { repoPath: '', connectionId: undefined, pathOverride: undefined, sshGeneration: undefined }

export function resetFixture(): void {
  fixture.connectionId = undefined
  fixture.pathOverride = undefined
  fixture.sshGeneration = undefined
}

/** A RuntimeFileCommands whose terminal grants stay on the returned instance. */
export function terminalFileCommands(): RuntimeFileCommands {
  const worktree = { id: `repo-1::${fixture.repoPath}`, repoId: 'repo-1', path: fixture.repoPath }
  return new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => makeStore(),
    resolveWorktreeSelector: async () => worktree,
    resolveRuntimeFileTarget: async () => ({ worktree }),
    resolveTerminalCwd: () => fixture.repoPath,
    resolveTerminalContext: () => ({ worktreeId: worktree.id, connectionId: null }),
    hasRecentTerminalOutputPath: () => true,
    resolveRuntimeGitTarget: async () => ({ worktree }),
    openFile: () => {},
    openDiff: () => {}
  } as never)
}

export function makeStore() {
  const repo = {
    id: 'repo-1',
    path: fixture.pathOverride ?? fixture.repoPath,
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    ...(fixture.connectionId ? { connectionId: fixture.connectionId } : {})
  }
  return {
    getRepo: (id: string) => (id === 'repo-1' ? repo : undefined),
    getRepos: () => [repo],
    addRepo: () => {},
    updateRepo: () => ({}) as never,
    getAllWorktreeMeta: () => ({}),
    // Why: an SSH repo's worktrees cannot be scanned without a provider; stored meta is the
    // documented fallback `resolveWorktreeSelector` uses to build the target from its id.
    getWorktreeMeta: (worktreeId: string) =>
      fixture.connectionId && worktreeId === `repo-1::${fixture.pathOverride ?? fixture.repoPath}`
        ? ({ displayName: 'wt', isArchived: false } as never)
        : undefined,
    setWorktreeMeta: () => ({}) as never,
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: join(tmpdir(), 'orca-admin-path-workspaces'),
      nestWorkspaces: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
}

/** A real repository plus every name a segment-equality check must NOT catch. */
export async function buildRepo(gitAsPointerFile = false): Promise<void> {
  fixture.repoPath = await mkdtemp(join(tmpdir(), 'orca-admin-path-'))
  if (gitAsPointerFile) {
    await writeFile(
      join(fixture.repoPath, '.git'),
      'gitdir: /elsewhere/.git/worktrees/feature\n',
      'utf-8'
    )
  } else {
    await mkdir(join(fixture.repoPath, '.git', 'refs'), { recursive: true })
    await mkdir(join(fixture.repoPath, '.git', 'worktrees', 'x'), { recursive: true })
    await writeFile(join(fixture.repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    await writeFile(join(fixture.repoPath, '.git', 'config'), '[core]\n', 'utf-8')
    await writeFile(
      join(fixture.repoPath, '.git', 'worktrees', 'x', 'gitdir'),
      '/elsewhere/.git\n',
      'utf-8'
    )
  }
  await mkdir(join(fixture.repoPath, '.github', 'workflows'), { recursive: true })
  await writeFile(join(fixture.repoPath, '.github', 'workflows', 'ci.yml'), 'on: push\n', 'utf-8')
  await mkdir(join(fixture.repoPath, 'src'), { recursive: true })
  await writeFile(join(fixture.repoPath, 'src', '.gitkeep'), '', 'utf-8')
  await mkdir(join(fixture.repoPath, 'mygit'), { recursive: true })
  await writeFile(join(fixture.repoPath, 'mygit', 'note.txt'), 'not admin state\n', 'utf-8')
  await writeFile(join(fixture.repoPath, '.gitignore'), 'node_modules\n', 'utf-8')
  await writeFile(join(fixture.repoPath, '.gitattributes'), '* text=auto\n', 'utf-8')
  await writeFile(join(fixture.repoPath, '.gitmodules'), '[submodule "a"]\n', 'utf-8')
  await writeFile(join(fixture.repoPath, 'git'), 'a file literally named git\n', 'utf-8')
  await writeFile(join(fixture.repoPath, 'tracked.txt'), 'working tree content\n', 'utf-8')
  listedWorktrees.splice(0, listedWorktrees.length, { path: fixture.repoPath })
}

export function dispatchFileMethod(
  method: string,
  params: Record<string, unknown>
): Promise<RpcResponse> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS } as never)
  return dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method,
    params: {
      worktree: fixture.connectionId
        ? `id:repo-1::${fixture.pathOverride ?? fixture.repoPath}`
        : `path:${fixture.repoPath}`,
      expectedExecutionHostId: fixture.connectionId ? `ssh:${fixture.connectionId}` : 'local',
      // A real client pairs the host id with the target and its connection generation.
      ...(fixture.connectionId && fixture.sshGeneration !== undefined
        ? {
            expectedSshTargetId: fixture.connectionId,
            expectedSshConnectionGeneration: fixture.sshGeneration
          }
        : {}),
      ...params
    }
  })
}

export function expectRefused(response: RpcResponse): void {
  expect(response.ok).toBe(false)
  expect((response as { error: { message: string } }).error.message).toBe(
    REPOSITORY_ADMIN_PATH_DENIED_MESSAGE
  )
}

/** The admin state that must be byte-identical after every refused call. */
export async function readAdminState(): Promise<Record<string, string>> {
  const names = await readdir(join(fixture.repoPath, '.git'))
  const entries: Record<string, string> = {}
  for (const name of names.sort()) {
    entries[name] = existsSync(join(fixture.repoPath, '.git', name)) ? 'present' : 'missing'
  }
  entries['HEAD:content'] = await readFile(join(fixture.repoPath, '.git', 'HEAD'), 'utf-8')
  entries['config:content'] = await readFile(join(fixture.repoPath, '.git', 'config'), 'utf-8')
  return entries
}
