import type { FilesystemHandlerContext } from '../ipc/filesystem/filesystem-handler-context'
import type { IFilesystemProvider } from '../providers/types'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { gitExecFileAsync as realGit } from '../git/command-runner/git-exec-file'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'
import { hasUsableHostedReviewPushTarget } from '../../shared/hosted-review-push-target-admission'
import { resolveRelayPushTarget } from '../../relay/git-handler-push-target'

const state = vi.hoisted(() => ({
  root: '',
  endpoint: '',
  env: {} as NodeJS.ProcessEnv,
  pushes: [] as string[],
  handlers: new Map<string, (_event: unknown, args: unknown) => Promise<void>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (_event: unknown, args: unknown) => Promise<void>) =>
      state.handlers.set(name, handler)
  }
}))
vi.mock('./gh-utils', () => ({
  acquire: async () => {},
  release: () => {},
  githubRepoContext: () => ({}),
  ghRepoExecOptions: () => ({}),
  getRemoteUrlForRepo: async () => state.endpoint,
  gitExecFileAsync: (args: string[]) =>
    realGit(args, { cwd: state.root, env: state.env, timeout: 10_000 }),
  ghExecFileAsync: async () => ({
    stdout: JSON.stringify({
      head: {
        ref: 'feature',
        repo: {
          name: 'repo',
          owner: { login: 'team' },
          clone_url: state.endpoint,
          ssh_url: state.endpoint
        }
      }
    })
  })
}))
vi.mock('./github-api-repository', () => ({
  getGitHubApiRepositoryForRemote: async () => ({ host: '127.0.0.1', owner: 'team', repo: 'repo' }),
  githubHostExecOptions: () => ({})
}))
vi.mock('./client/pull-request-lookup-candidates', () => ({
  resolvePullRequestLookupCandidates: async () => [
    { host: '127.0.0.1', owner: 'team', repo: 'repo' }
  ]
}))
vi.mock('./client', async () => ({
  createGitHubPullRequest: vi.fn(() => {
    throw new Error('Unexpected live forge request')
  }),
  getPullRequestPushTarget: (await import('./client/lookup/pull-request-push-target'))
    .getPullRequestPushTarget,
  getWorkItem: async () => ({ type: 'pr', branchName: 'feature' })
}))
vi.mock('../git/runner', () => ({
  gitExecFileAsync: async (args: string[]) => {
    const result = await realGit(
      args[0] === 'push' ? ['push', '--dry-run', '--porcelain', ...args.slice(1)] : args,
      { cwd: state.root, env: state.env, timeout: 10_000 }
    )
    if (args[0] === 'push') {
      state.pushes.push(result.stdout)
    }
    return result
  }
}))
import { getPullRequestPushTarget } from './client/lookup/pull-request-push-target'
import { resolveGitHubPrStartPoint } from './pr-start-point'
import { gitPush } from '../git/remote'

let root: string
let daemon: ReturnType<typeof spawnProcess>
let other: string
const run = (args: string[]) => realGit(args, { cwd: root, env: state.env, timeout: 10_000 })
const git = async (...args: string[]) => (await run(args)).stdout.trim()
const refs = () =>
  Promise.all(
    [root, join(root, 'team/repo.git'), join(root, 'other/repo.git')].map(
      async (cwd) =>
        (
          await realGit(['for-each-ref', '--format=%(refname) %(objectname)'], {
            cwd,
            env: state.env
          })
        ).stdout
    )
  )

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-push-authority-'))
  state.root = root
  state.env = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'empty-config'),
    ORCA_BACKGROUND_LAUNCH: '1'
  }
  await git('init', '-q')
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'base'
  )
  await git('branch', '-M', 'feature')
  for (const path of ['team/repo.git', 'other/repo.git']) {
    await git('clone', '--bare', '-q', root, join(root, path))
  }
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  daemon = spawnProcess({
    program: 'git',
    args: [
      'daemon',
      '--verbose',
      '--export-all',
      '--enable=receive-pack',
      '--listen=127.0.0.1',
      `--port=${port}`,
      `--base-path=${root}`,
      root
    ],
    cwd: root,
    env: state.env
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Git daemon startup timed out')), 10_000)
    daemon.once('error', reject)
    daemon.stderr.on('data', (chunk) => {
      if (String(chunk).includes('Ready to rumble')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  state.endpoint = `git://127.0.0.1:${port}/team/repo.git`
  other = `git://127.0.0.1:${port}/other/repo.git`
  await git('remote', 'add', 'origin', state.endpoint)
  await git('fetch', '-q', 'origin')
})
afterAll(async () => {
  if (daemon) {
    expect(daemon.spawnargs).toContain(root)
    const closed = once(daemon, 'close')
    daemon.kill('SIGTERM')
    await closed
  }
  await rm(root, { recursive: true, force: true })
})

it('carries shipping hydrated identity through status, admission, local and relay execution', async () => {
  const resolved = await resolveGitHubPrStartPoint({
    repoPath: root,
    prNumber: 42,
    gitExec: run,
    resolveRemote: async () => 'origin',
    fetchRemoteTrackingRef: async () => {
      await git('fetch', '-q', 'origin')
    },
    fetchPullRequestHeadRef: async () => {
      throw new Error('unexpected fork fetch')
    }
  })
  expect(resolved).not.toHaveProperty('error')
  if ('error' in resolved || !resolved.pushTarget) {
    throw new Error('Missing hydrated target')
  }
  const target = resolved.pushTarget
  const status = await getPublishTargetStatus(run, target)
  expect(
    hasUsableHostedReviewPushTarget({
      pushTarget: target,
      upstreamStatus: status,
      hasResolvableHostedReviewPushTargetLink: true
    })
  ).toBe(true)
  const before = await refs()
  const config = await readFile(join(root, '.git/config'))
  await gitPush(root, false, target)
  expect(state.pushes.at(-1)).toContain(state.endpoint)
  const relay = await resolveRelayPushTarget((args) => run(args), root, target)
  await git('push', '--dry-run', '--porcelain', relay!.remote, relay!.refspec)
  expect(await refs()).toEqual(before)
  expect(await readFile(join(root, '.git/config'))).toEqual(config)

  for (const urls of [[other], [state.endpoint, other]]) {
    await git('config', '--replace-all', 'remote.origin.pushurl', urls[0]!)
    if (urls[1]) {
      await git('config', '--add', 'remote.origin.pushurl', urls[1])
    }
    const configBefore = await readFile(join(root, '.git/config'))
    expect(await getPullRequestPushTarget(root, 42)).toBeNull()
    const denied = await getPublishTargetStatus(run, target)
    expect(
      hasUsableHostedReviewPushTarget({
        pushTarget: target,
        upstreamStatus: denied,
        hasResolvableHostedReviewPushTargetLink: true
      })
    ).toBe(false)
    await expect(gitPush(root, false, target)).rejects.toThrow('authority')
    await expect(resolveRelayPushTarget((args) => run(args), root, target)).rejects.toThrow(
      'authority'
    )
    const control = await git(
      'push',
      '--dry-run',
      '--porcelain',
      'origin',
      'HEAD:refs/heads/feature'
    )
    for (const url of urls) {
      expect(control).toContain(url)
    }
    expect(await refs()).toEqual(before)
    expect(await readFile(join(root, '.git/config'))).toEqual(configBefore)
  }
})

it('uses Git rewrite and pushurl selection rules without changing configuration during execution', async () => {
  await git('config', '--unset-all', 'remote.origin.pushurl')
  await git('remote', 'set-url', 'origin', 'fixture:review')
  await git('config', `url.${state.endpoint}.insteadOf`, 'fixture:review')
  const before = await refs()
  const verify = async (accepted: boolean, destinations: string[]): Promise<void> => {
    const config = await readFile(join(root, '.git/config'))
    const resolved = await getPullRequestPushTarget(root, 42)
    expect(!!resolved?.pushTarget).toBe(accepted)
    if (resolved?.pushTarget) {
      await gitPush(root, false, resolved.pushTarget)
    }
    const dryRun = await git(
      'push',
      '--dry-run',
      '--porcelain',
      'origin',
      'HEAD:refs/heads/feature'
    )
    for (const destination of destinations) {
      expect(dryRun).toContain(destination)
    }
    expect(await refs()).toEqual(before)
    expect(await readFile(join(root, '.git/config'))).toEqual(config)
  }
  await verify(true, [state.endpoint])
  await git('config', `url.${other}.pushInsteadOf`, 'fixture:review')
  await verify(false, [other])
  await git('config', 'remote.origin.pushurl', state.endpoint)
  await verify(true, [state.endpoint])
  await git('config', '--unset-all', 'remote.origin.pushurl')
  await git('config', '--unset-all', `url.${other}.pushInsteadOf`)
  await git('remote', 'set-url', 'origin', state.endpoint)
  await git('config', '--add', 'remote.origin.url', other)
  await verify(false, [state.endpoint, other])
})

it('carries provider-produced authority through omitted-target SSH IPC aliases to host execution', async () => {
  const { registerGitRemoteBranchMutationHandlers } =
    await import('../ipc/filesystem/git-remote/branch-mutation-handlers')
  const { registerSshGitProvider, unregisterSshGitProvider } =
    await import('../providers/ssh-git-dispatch')
  const { registerSshFilesystemProvider, unregisterSshFilesystemProvider } =
    await import('../providers/ssh-filesystem-dispatch')
  const { SshGitProvider } = await import('../providers/ssh-git-provider')
  const { createMockMux } = await import('../providers/ssh-git-provider-test-harness')
  const canonical = await realpath(root)
  const alias = join(root, 'workspace-alias')
  await symlink(canonical, alias, 'dir')
  await git('config', '--unset-all', 'remote.origin.pushurl').catch(() => {})
  await git('config', '--replace-all', 'remote.origin.url', state.endpoint)
  const target = (await getPullRequestPushTarget(root, 42))?.pushTarget
  expect(target?.reviewHead).toBeDefined()
  const metadata: Record<string, Partial<WorktreeMeta>> = {
    [`repo::${canonical}`]: { pushTarget: target! }
  }
  const store = {
    getRepos: () => [{ id: 'repo', path: canonical, connectionId: 'identity-fixture' }],
    getAllWorktreeMetaForHost: () => metadata,
    getWorktreeMetaForHost: (id: string) => metadata[id]
  } as unknown as Store
  const mux = createMockMux()
  const pushes: string[] = []
  mux.request.mockImplementation(async (method, params) => {
    if (method === 'git.exec') {
      expect(params.cwd).toBe(canonical)
      return run(params.args)
    }
    if (method === 'git.listWorktrees') {
      expect(await git('rev-parse', '--show-toplevel')).toBe(canonical)
      return [{ path: canonical, head: '', branch: 'feature', isBare: false, isMainWorktree: true }]
    }
    expect(method).toBe('git.push')
    expect(params.worktreePath).toBe(canonical)
    const resolved = await resolveRelayPushTarget((args) => run(args), canonical, params.pushTarget)
    pushes.push(
      (
        await run([
          'push',
          '--dry-run',
          '--porcelain',
          resolved?.remote ?? 'origin',
          resolved?.refspec ?? 'HEAD'
        ])
      ).stdout
    )
    return undefined
  })
  registerSshGitProvider('identity-fixture', new SshGitProvider('identity-fixture', mux as never))
  registerSshFilesystemProvider('identity-fixture', {
    realpath
  } as unknown as IFilesystemProvider)
  try {
    registerGitRemoteBranchMutationHandlers({
      store
    } as FilesystemHandlerContext)
    const push = state.handlers.get('git:push')!
    const before = await refs()
    for (const path of [canonical, `${canonical}/.`, `${canonical}/`, alias]) {
      await push(null, { worktreePath: path, connectionId: 'identity-fixture' })
      expect(pushes.at(-1)).toContain(state.endpoint)
    }
    await git('config', 'remote.origin.pushurl', other)
    const config = await readFile(join(root, '.git/config'))
    for (const provider of ['github', 'gitlab']) {
      metadata[`repo::${canonical}`] = {
        pushTarget: {
          ...target!,
          reviewHead: { ...target!.reviewHead!, provider: provider as 'github' | 'gitlab' }
        }
      }
      await expect(
        push(null, { worktreePath: alias, connectionId: 'identity-fixture' })
      ).rejects.toThrow('mismatch')
      metadata[`repo::${canonical}`] =
        provider === 'github' ? { linkedPR: 42 } : { linkedGitLabMR: 42 }
      await expect(
        push(null, { worktreePath: `${canonical}/.`, connectionId: 'identity-fixture' })
      ).rejects.toThrow('unresolved')
    }
    metadata[`repo::${canonical}`] = { pushTarget: target! }
    await expect(
      push(null, {
        worktreePath: alias,
        connectionId: 'identity-fixture',
        pushTarget: { ...target!, remoteName: 'stale' }
      })
    ).rejects.toThrow('changed')
    expect(pushes).toHaveLength(4)
    expect(await refs()).toEqual(before)
    expect(await readFile(join(root, '.git/config'))).toEqual(config)
    await git('config', 'remote.origin.pushurl', state.endpoint)
    delete metadata[`repo::${canonical}`]
    await push(null, { worktreePath: alias, connectionId: 'identity-fixture' })
    expect(pushes).toHaveLength(5)
    expect(pushes.at(-1)).toContain(state.endpoint)
    expect(await refs()).toEqual(before)
  } finally {
    unregisterSshGitProvider('identity-fixture')
    unregisterSshFilesystemProvider('identity-fixture')
    await rm(alias)
  }
})
