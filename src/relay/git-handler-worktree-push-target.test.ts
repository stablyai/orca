import { describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import {
  addWorktreePushTargetRemoteOp,
  configureWorktreePushTargetOp,
  removeWorktreePushTargetRemoteOp
} from './git-handler-worktree-push-target'

const target = {
  remoteName: 'pr-contributor-orca',
  branchName: 'contributor/fix',
  remoteUrl: 'git@github.com:contributor/orca.git'
}

function gitWithRemoteUrl(remoteUrl = target.remoteUrl) {
  return vi.fn<GitExec>(async (args) => ({
    stdout: args[0] === 'remote' && args[1] === 'get-url' ? `${remoteUrl}\n` : '',
    stderr: ''
  }))
}

describe('relay worktree push-target mutations', () => {
  it('adds a validated fork remote through the narrow operation', async () => {
    const git = gitWithRemoteUrl()
    await addWorktreePushTargetRemoteOp(git, { repoPath: '/repo', target })
    expect(git.mock.calls).toEqual([
      [['remote', 'add', target.remoteName, target.remoteUrl], '/repo']
    ])
  })

  it('configures the created local branch upstream', async () => {
    const git = gitWithRemoteUrl()
    await configureWorktreePushTargetOp(git, {
      worktreePath: '/repo-fix',
      branchName: 'local-fix',
      target
    })
    expect(git.mock.calls).toEqual([
      [
        ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, 'local-fix'],
        '/repo-fix'
      ]
    ])
  })

  it('re-reads and matches the expected URL before removal', async () => {
    const git = gitWithRemoteUrl('https://github.com/contributor/orca.git')
    await removeWorktreePushTargetRemoteOp(git, { repoPath: '/repo', target })
    expect(git.mock.calls).toEqual([
      [['remote', 'get-url', target.remoteName], '/repo'],
      [['remote', 'remove', target.remoteName], '/repo']
    ])
  })

  it('keeps the remote after its URL changes', async () => {
    const git = gitWithRemoteUrl('git@github.com:someone-else/orca.git')
    await expect(
      removeWorktreePushTargetRemoteOp(git, { repoPath: '/repo', target })
    ).resolves.toBe(undefined)
    expect(git).not.toHaveBeenCalledWith(['remote', 'remove', target.remoteName], '/repo')
  })

  it('passes Windows worktree paths through without rewriting', async () => {
    const git = gitWithRemoteUrl()
    await configureWorktreePushTargetOp(git, {
      worktreePath: 'C:\\workspace\\repo-fix',
      branchName: 'local-fix',
      target
    })
    expect(git).toHaveBeenCalledWith(
      ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, 'local-fix'],
      'C:\\workspace\\repo-fix'
    )
  })

  it('rejects an option-like local branch', async () => {
    const git = gitWithRemoteUrl()
    await expect(
      configureWorktreePushTargetOp(git, {
        worktreePath: '/repo-fix',
        branchName: '--delete',
        target
      })
    ).rejects.toThrow('Invalid worktree push target local branch name')
    expect(git).not.toHaveBeenCalled()
  })

  it.each([
    ['reserved remote', { ...target, remoteName: 'origin' }],
    ['unsafe remote', { ...target, remoteName: '../fork' }],
    ['unsafe branch', { ...target, branchName: '-fix' }],
    ['unsupported URL', { ...target, remoteUrl: 'ssh://github.com/contributor/orca.git' }]
  ])('rejects %s input', async (_label, invalidTarget) => {
    const git = gitWithRemoteUrl()
    await expect(
      addWorktreePushTargetRemoteOp(git, { repoPath: '/repo', target: invalidTarget })
    ).rejects.toThrow()
    expect(git).not.toHaveBeenCalledWith(
      expect.arrayContaining(['remote', 'add']),
      expect.any(String)
    )
  })
})
