import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gitExecFileAsync as realGit } from '../git/command-runner/git-exec-file'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import type { SshGitProvider } from '../providers/ssh-git-provider'

const { runner } = vi.hoisted(() => ({ runner: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: runner }))
import {
  materializeWorktreePushTargetRemote,
  materializeWorktreePushTargetRemoteSsh
} from './worktree-remote'

let root: string
let repo: string
let remote: string
const remoteUrl = 'ssh://git@fixture.invalid/owner/fork.git'
let env: NodeJS.ProcessEnv
const exec = (args: string[], cwd = repo) => realGit(args, { cwd, env, timeout: 10_000 })
const git = async (...args: string[]) => (await exec(args)).stdout.trim()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-materialize-identity-'))
  repo = join(root, 'workspace')
  remote = join(root, 'fork.git')
  const config = join(root, 'config')
  await writeFile(config, '')
  const ssh = join(root, 'synthetic-ssh')
  await writeFile(ssh, `#!/bin/sh\nexec git-upload-pack ${quotePosixShell(remote)}\n`)
  await chmod(ssh, 0o700)
  env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: config,
    ORCA_BACKGROUND_LAUNCH: '1',
    GIT_SSH_COMMAND: quotePosixShell(ssh),
    GIT_SSH_VARIANT: 'ssh',
    FIXTURE_REMOTE: remote
  }
  await exec(['init', '-q', repo], root)
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture'
  )
  await git('branch', '-M', 'feature')
  await git('clone', '--bare', '-q', repo, remote)
  runner.mockReset().mockImplementation((args, options) => exec(args, options.cwd))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

for (const route of ['local', 'wsl', 'ssh'] as const) {
  for (const lifecycle of ['new', 'reused'] as const) {
    for (const collision of lifecycle === 'reused'
      ? ['none', 'branch-tag', 'upstream-tag', 'custom-mapping', 'heads-mapping']
      : ['none', 'branch-tag', 'upstream-tag']) {
      it(`${route} ${lifecycle} materializer retains canonical identity with ${collision}`, async () => {
        const tracking =
          ['custom-mapping', 'heads-mapping'].includes(collision) && lifecycle === 'reused'
            ? collision === 'heads-mapping'
              ? 'refs/heads/tracking/feature'
              : 'refs/custom/fork/feature'
            : 'refs/remotes/fork/feature'
        if (lifecycle === 'reused') {
          await git('remote', 'add', 'fork', remoteUrl)
          if (['custom-mapping', 'heads-mapping'].includes(collision)) {
            await git(
              'config',
              'remote.fork.fetch',
              `+refs/heads/*:${tracking.replace('feature', '*')}`
            )
            await git('update-ref', 'refs/remotes/fork/feature', await git('rev-parse', 'HEAD'))
          }
        }
        if (collision === 'branch-tag') {
          await git('tag', 'feature')
          await git('branch', 'heads/feature', 'refs/heads/feature')
          await git('config', 'branch.heads/feature.remote', 'unrelated')
        }
        if (collision === 'upstream-tag') {
          await git('tag', 'fork/feature')
        }
        const target = { remoteName: 'fork', branchName: 'feature', remoteUrl }
        const remoteRefs = (
          await exec(['for-each-ref', '--format=%(refname) %(objectname)'], remote)
        ).stdout
        const provider = {
          exec,
          markRemoteOrcaCreated: (cwd: string, name: string) =>
            exec(['config', `remote.${name}.orca-created`, 'true'], cwd),
          fetchRemoteTrackingRef: (cwd: string, name: string, branch: string, ref: string) =>
            exec(['fetch', name, `+refs/heads/${branch}:${ref}`], cwd)
        } as unknown as SshGitProvider
        const result =
          route === 'ssh'
            ? await materializeWorktreePushTargetRemoteSsh(provider, repo, target)
            : await materializeWorktreePushTargetRemote(
                repo,
                target,
                undefined,
                undefined,
                route === 'wsl' ? { wslDistro: 'synthetic' } : {}
              )
        expect(result.remoteName).toBe('fork')
        expect(await git('symbolic-ref', 'HEAD')).toBe('refs/heads/feature')
        expect(await git('config', 'branch.feature.remote')).toBe('fork')
        expect(await git('config', 'branch.feature.merge')).toBe('refs/heads/feature')
        expect(await git('for-each-ref', '--format=%(upstream)', 'refs/heads/feature')).toBe(
          tracking
        )
        expect(await git('rev-parse', '--verify', tracking)).toBe(await git('rev-parse', 'HEAD'))
        expect(
          (await exec(['for-each-ref', '--format=%(refname) %(objectname)'], remote)).stdout
        ).toBe(remoteRefs)
        if (collision === 'branch-tag') {
          expect(await git('config', 'branch.heads/feature.remote')).toBe('unrelated')
        }
        if (route === 'wsl') {
          expect(runner.mock.calls.every(([, options]) => options.wslDistro === 'synthetic')).toBe(
            true
          )
        }
      })
    }
  }
}
