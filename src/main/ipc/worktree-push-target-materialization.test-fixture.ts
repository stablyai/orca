import '../../shared/git-worktree-admin'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, vi } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import '../../shared/worktree/host-qualified-identity'
import './worktree-remote'
import '../git/fork-remote-refspec'
import '../git/remote'
import '../../shared/git-publish-target-status'
import '../git/upstream'
import '../../shared/hosted-review-push-target'
import '../git/repo-remote-file-target'
import '../git/hosted-remote-url'
import '../../shared/git-push-target-resolution'
import { RuntimeGitSyncCommands } from '../runtime/runtime-git-sync-commands'
import '../runtime/runtime-terminal-spawn-push-target-materialization'
import '../../shared/git-effective-upstream'
import '../git/branch-rename'
import '../../shared/git-configured-branch-target'
import '../runtime/runtime-store-partial-fixture'
import '../runtime/orca-runtime'
import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import '../runtime/rpc/dispatcher'
import '../runtime/rpc/methods/git'
import './filesystem/git-remote/sync-handlers'
import './filesystem/filesystem-handler-context'
import './sender-scoped-request-cancellation'
import './registered-worktree-roots-cache'
import { resetRepoGitRemoteIdentityEnrichmentForTests } from '../repo-git-remote-identity-enrichment'
import '../../shared/project-host-setup-projection'
import '../../shared/git-remote-identity'
import '../../shared/repo-icon'
import '../../shared/execution-host'
import type * as NodeFs from 'node:fs/promises'

const { runner, handle, legacyReadFailure } = vi.hoisted(() => ({
  runner: vi.fn(),
  handle: vi.fn(),
  legacyReadFailure: { file: '' }
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof NodeFs>()
  return {
    ...actual,
    lstat: new Proxy(actual.lstat, {
      apply(fn: (...args: any[]) => ReturnType<typeof actual.lstat>, receiver, args) {
        if (String(args[0]) === legacyReadFailure.file) {
          return Promise.reject(
            Object.assign(new Error('owning-provider read denied'), { code: 'EACCES' })
          )
        }
        return fn.apply(receiver, args)
      }
    })
  }
})
vi.mock('electron', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ipcMain: { handle }
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: runner }))

const exec = promisify(execFile)
const url = 'git@github.com:contributor/orca.git'
let scratch: string, repo: string, fork: string, a: string, b: string
let env: NodeJS.ProcessEnv
const interception: {
  afterIntercept?: (args: string[], cwd: string) => Promise<void>
  intercept?: (args: string[], cwd: string) => Promise<void>
} = {}
const target = (branchName = 'topic'): GitPushTarget => ({
  remoteName: 'pr-contributor',
  remoteUrl: url,
  branchName,
  remoteCreated: true
})
const git = async (args: string[], cwd = repo) => (await exec('git', args, { cwd, env })).stdout
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'orca-sta-11914-')))
  repo = join(scratch, 'repo')
  fork = join(scratch, 'fork')
  a = join(scratch, 'a')
  b = join(scratch, 'b')
  const home = join(scratch, 'home')
  await mkdir(home)
  await mkdir(repo)
  const ssh = join(scratch, 'ssh')
  await writeFile(
    ssh,
    '#!/bin/sh\nendpoint="$ORCA_TEST_FORK"\ncase "$*" in *other/orca*|*literal.test*) endpoint="$ORCA_TEST_FORK-other";; esac\ncase "$*" in *orca-test-receiver*) echo used > "$ORCA_TEST_FORK-receiver"; exec git-receive-pack "$endpoint";; *git-receive-pack*) exec git-receive-pack "$endpoint";; *) exec git-upload-pack "$endpoint";; esac\n'
  )
  await chmod(ssh, 0o700)
  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    ),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: join(home, 'empty'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `sh '${ssh.replaceAll('\\', '/')}'`,
    GIT_SSH_VARIANT: 'ssh',
    ORCA_TEST_FORK: fork
  }
  await git(['init', '-q'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.test'])
  await git(['config', 'commit.gpgSign', 'false'])
  await git(['config', 'core.hooksPath', join(scratch, 'no-hooks')])
  await git(['commit', '--allow-empty', '-qm', 'seed'])
  await git(['branch', 'topic'])
  await git(['branch', 'other'])
  await git(['clone', '--bare', '-q', repo, fork])
  await git(['config', 'user.name', 'Test'], fork)
  await git(['config', 'user.email', 'test@example.test'], fork)
  await git(['worktree', 'add', '-qb', 'local-a', a])
  await git(['worktree', 'add', '-qb', 'local-b', b])
  await git(['remote', 'add', 'pr-contributor', 'git@github.com:someone-else/orca.git'])
  interception.intercept = undefined
  interception.afterIntercept = undefined
  legacyReadFailure.file = ''
  runner.mockReset().mockImplementation(async (args: string[], options: { cwd: string }) => {
    await interception.intercept?.(args, options.cwd)
    const result = await exec('git', args, { cwd: options.cwd, env })
    if (args.includes('remote') && args.includes('-v')) {
      result.stdout = result.stdout.replace(/ \(fetch\)(?=\r?$)/gm, ' (fetch) [blob:none]')
    }
    await interception.afterIntercept?.(args, options.cwd)
    return result
  })
})
afterEach(async () => {
  resetRepoGitRemoteIdentityEnrichmentForTests()
  await rm(scratch, { recursive: true, force: true })
})

function runtimeCommands() {
  return new RuntimeGitSyncCommands({
    resolveRuntimeGitTarget: async () => ({
      executionHostId: 'local',
      worktree: {
        id: `repo::${a}`,
        repoId: 'repo',
        path: a,
        displayName: 'test',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        git: { path: a, head: '', branch: 'local-a', isBare: false, isMainWorktree: false }
      }
    }),
    getRuntimeSettings: () => ({}),
    persistMaterializedPushTarget: () => {
      throw new Error('bookkeeping unavailable')
    }
  })
}

async function oldForkFetch(path: string, name?: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await runner(['fetch', '--prune', ...(name ? [name] : [])], { cwd: path })
      return
    } catch (error) {
      const stderr =
        error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr
          : ''
      const stale = /couldn't find remote ref (refs\/heads\/\S+)/.exec(stderr)?.[1]
      if (!name || !stale) {
        throw error
      }
      const key = `remote.${name}.fetch`
      const existing = (await git(['config', '--get-all', key], path)).trim().split('\n')
      const surviving = existing.filter((spec) => spec.replace(/^\+/, '').split(':')[0] !== stale)
      if (surviving.length === existing.length) {
        throw error
      }
      await git(['config', '--unset-all', key], path)
      for (const spec of surviving) {
        await git(['config', '--add', key, spec], path)
      }
    }
  }
  throw new Error('Exceeded stale fork-remote refspec repair attempts')
}

export {
  runner,
  handle,
  legacyReadFailure,
  exec,
  url,
  scratch,
  repo,
  fork,
  a,
  b,
  env,
  interception,
  target,
  git,
  deferred,
  runtimeCommands,
  oldForkFetch
}
