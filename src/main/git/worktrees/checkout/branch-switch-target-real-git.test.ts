import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BranchSwitchTarget } from '../../../../shared/git/branch-switch-target'
import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { switchBranchGuarded } from './branch-switch'
import { BranchSwitchCollisionError } from './branch-switch-target'
import { checkoutBranch, listLocalBranches } from './checkout'
import { getStatus } from '../../source-control/status/status-read'
import { searchRemoteRefPage } from '../../refs/resolution/repo-remote-ref-search'

let directory: string
let initialHead: string
async function git(...args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd: directory,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z'
    }
  })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}
function switchTo(target: BranchSwitchTarget, blocker: string | null = null, onSwitched = vi.fn()) {
  return switchBranchGuarded(
    directory,
    target,
    {},
    {
      getStatus: () => getStatus(directory, { includeLineStats: false }),
      checkout: (branch, creation) => checkoutBranch(directory, branch, {}, creation),
      getAgentBlocker: async () => blocker,
      onSwitched
    }
  )
}
async function remote(name: string) {
  await git('remote', 'add', name, './unused')
  await git('update-ref', `refs/remotes/${name}/topic`, 'HEAD')
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-branch-target-')))
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(directory, 'file.txt'), 'base\n')
  await git('add', 'file.txt')
  await git('commit', '-qm', 'base')
  initialHead = await git('rev-parse', 'HEAD')
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('switches an exact local target and records it', async () => {
  await git('branch', 'feature')
  const recorded = vi.fn()
  expect(await switchTo({ kind: 'local', name: 'feature' }, null, recorded)).toEqual({
    branch: 'feature',
    previousBranch: 'main',
    head: initialHead
  })
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('feature')
  expect(recorded).toHaveBeenCalledOnce()
})
it.each(['team/upstream', 'origin'])(
  'resolves %s explicitly even with a slash-named local',
  async (name) => {
    await remote(name)
    await git('branch', `${name}/topic`)
    await switchTo({ kind: 'remote', name: `${name}/topic` })
    expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('topic')
    expect(await git('rev-parse', '--symbolic-full-name', '@{upstream}')).toBe(
      `refs/remotes/${name}/topic`
    )
    expect(await git('rev-parse', `refs/heads/${name}/topic`)).toBe(await git('rev-parse', 'main'))
  }
)
it('returns the advanced HEAD when reusing a differently named local tracker', async () => {
  await remote('origin')
  await git('branch', '--track', 'my-topic', 'refs/remotes/origin/topic')
  await git('checkout', '-q', 'my-topic')
  await git('commit', '--allow-empty', '-qm', 'local advance')
  const advanced = await git('rev-parse', 'HEAD')
  await git('checkout', '-q', 'main')
  expect(await switchTo({ kind: 'remote', name: 'origin/topic' })).toEqual({
    branch: 'my-topic',
    previousBranch: 'main',
    head: advanced
  })
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('my-topic')
  expect((await listLocalBranches(directory)).branches).not.toContain('topic')
})
it('creates from HEAD without tracking despite autoSetupMerge and an exact remote match', async () => {
  await remote('origin')
  await git('config', 'branch.autoSetupMerge', 'always')
  await switchTo({ kind: 'new', name: 'topic' })
  expect(await git('rev-parse', 'HEAD')).toBe(await git('rev-parse', 'main'))
  expect(await git('for-each-ref', '--format=%(upstream)', 'refs/heads/topic')).toBe('')
})
it('refusals leave no new branch or tracking config behind', async () => {
  await remote('origin')
  await writeFile(join(directory, 'draft.txt'), 'draft')
  await expect(switchTo({ kind: 'remote', name: 'origin/topic' })).rejects.toThrow(
    'Commit or discard'
  )
  await expect(
    switchTo({ kind: 'new', name: 'draft' }, 'Codex is working in this workspace.')
  ).rejects.toThrow('Codex')
  expect(
    await git('for-each-ref', '--format=%(refname)', 'refs/heads/draft', 'refs/heads/topic')
  ).toBe('')
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('main')
})
it('carries uncommitted changes onto a new branch but refuses an existing branch', async () => {
  const commit = await git('rev-parse', 'HEAD')
  await git('branch', 'feature')
  await writeFile(join(directory, 'file.txt'), 'work in progress\n')
  await writeFile(join(directory, 'draft.txt'), 'draft\n')
  await expect(switchTo({ kind: 'local', name: 'feature' })).rejects.toThrow('Commit or discard')
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('main')
  await switchTo({ kind: 'new', name: 'draft' })
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('draft')
  expect(await git('rev-parse', 'HEAD')).toBe(commit)
  expect(await git('diff', '--name-only')).toBe('file.txt')
  expect(await readFile(join(directory, 'file.txt'), 'utf8')).toBe('work in progress\n')
  expect(await git('ls-files', '--others', '--exclude-standard')).toBe('draft.txt')
  expect(await readFile(join(directory, 'draft.txt'), 'utf8')).toBe('draft\n')
})
it('refuses creation of the current branch without recording a switch', async () => {
  const recorded = vi.fn()
  await expect(switchTo({ kind: 'new', name: 'main' }, null, recorded)).rejects.toMatchObject({
    data: { existingBranch: 'main' }
  })
  expect(recorded).not.toHaveBeenCalled()
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('main')
})
it('offers direct local collision recovery without relying on discovery', async () => {
  await git('branch', 'topic')
  await expect(switchTo({ kind: 'new', name: 'topic' })).rejects.toMatchObject({
    data: { existingBranch: 'topic' }
  })
  await remote('origin')
  await expect(switchTo({ kind: 'remote', name: 'origin/topic' })).rejects.toBeInstanceOf(
    BranchSwitchCollisionError
  )
  await switchTo({ kind: 'local', name: 'topic' })
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('topic')
})
it('probes the resolved local name when a remote checkout lands with a hook failure', async () => {
  await remote('team/upstream')
  await mkdir(join(directory, '.git', 'hooks-test'))
  const hook = join(directory, '.git', 'hooks-test', 'post-checkout')
  await writeFile(hook, '#!/bin/sh\necho "hook failed" >&2\necho logout >&2\nexit 1\n')
  await chmod(hook, 0o755)
  await git('config', 'core.hooksPath', '.git/hooks-test')
  const recorded = vi.fn()
  await expect(
    switchTo({ kind: 'remote', name: 'team/upstream/topic' }, null, recorded)
  ).rejects.toMatchObject({
    name: 'BranchSwitchLandedWithWarningError',
    branch: 'topic',
    head: initialHead
  })
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('topic')
  expect(recorded).toHaveBeenCalledOnce()
})
it('reports the landed HEAD when git errors after checkout', async () => {
  await git('branch', 'topic')
  await expect(
    switchBranchGuarded(
      directory,
      { kind: 'local', name: 'topic' },
      {},
      {
        getStatus: () => getStatus(directory, { includeLineStats: false }),
        checkout: async (branch) => {
          await git('checkout', '-q', branch)
          throw Object.assign(new Error('checkout failed'), {
            stderr: 'error: unable to create file app.css: Permission denied\n'
          })
        },
        getAgentBlocker: async () => null
      }
    )
  ).rejects.toMatchObject({
    name: 'BranchSwitchLandedWithWarningError',
    branch: 'topic',
    head: initialHead
  })
})
it('maps a remote not covered by its fetch settings to tracking recovery', async () => {
  await remote('origin')
  await git('config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other')
  await expect(switchTo({ kind: 'remote', name: 'origin/topic' })).rejects.toThrow(
    "isn't included in the remote's fetch settings"
  )
  expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('main')
})
it('reads live worktree occupancy and discovers remotes despite 50 local matches', async () => {
  await remote('origin')
  const newer = await runProcess({
    program: 'git',
    args: ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'newer local refs'],
    cwd: directory,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2024-01-02T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-02T00:00:00Z'
    }
  })
  expect(newer.code).toBe(0)
  const oid = newer.stdout.trim()
  const edits = Array.from({ length: 50 }, (_, n) => `create refs/heads/topic-${n} ${oid}`).join(
    '\n'
  )
  const transaction = await runProcess({
    program: 'git',
    args: ['update-ref', '--stdin'],
    cwd: directory,
    input: `${edits}\n`
  })
  expect(transaction.code).toBe(0)
  const page = await searchRemoteRefPage(directory, 'topic', 50)
  expect(page.refDetails).toEqual([
    { refName: 'refs/remotes/origin/topic', localBranchName: 'topic' }
  ])
  const occupied = join(directory, '.git', 'checkout-test')
  await git('worktree', 'add', '-q', occupied, 'topic-0')
  expect((await listLocalBranches(directory)).worktreePaths?.['topic-0']).toBe(occupied)
  await git('worktree', 'remove', occupied)
  expect((await listLocalBranches(directory)).worktreePaths?.['topic-0']).toBeUndefined()
  await git('worktree', 'add', '-q', occupied, 'topic-1')
  await rm(occupied, { recursive: true })
  expect((await listLocalBranches(directory)).worktreePaths?.['topic-1']).toBe(occupied)
  await git('checkout', '-qb', 'external-current')
  const updated = await listLocalBranches(directory)
  expect(updated.current).toBe('external-current')
  expect(updated.branches[0]).toBe('external-current')
  expect(updated.branches).toContain('topic-0')
  expect(updated.branches).toContain('topic-9')
})
it('does not overlay an unborn local branch over a remote branch', async () => {
  await git('update-ref', 'refs/remotes/origin/main', initialHead)
  await git('update-ref', '-d', 'refs/heads/main')
  const local = await listLocalBranches(directory)
  expect(local.current).toBeNull()
  expect(local.branches).toEqual([])
  expect((await searchRemoteRefPage(directory, 'main', 30)).refDetails).toEqual([
    { refName: 'refs/remotes/origin/main', localBranchName: 'main' }
  ])
})
installRealWorkerThreadChildProcesses()
