import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

import { resolveRuntimeGitHubWorktreeBase } from './runtime-github-worktree-base'
import { resolveRuntimeGitLabWorktreeBase } from './runtime-gitlab-worktree-base'

const store = { getProjects: () => [], getSettings: () => ({}) }

function repoOn(fields: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return {
    id: 'repo-1',
    path: '/srv/project',
    displayName: 'project',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...fields
  }
}

const PROVIDERS = [
  [
    'GitHub',
    (resolveRepo: () => Promise<Repo>) =>
      resolveRuntimeGitHubWorktreeBase(
        { repoSelector: 'id:repo-1', prNumber: 7, headRefName: 'feature' },
        { store, resolveRepo }
      )
  ],
  [
    'GitLab',
    (resolveRepo: () => Promise<Repo>) =>
      resolveRuntimeGitLabWorktreeBase(
        { repoSelector: 'id:repo-1', mrIid: 7, sourceBranch: 'feature', targetBranch: 'main' },
        { store, resolveRepo }
      )
  ]
] as const

// Why each row: rows written by unified-host code carry only `executionHostId`; a `connectionId`
// beside `local` contradicts itself, and beside `runtime:` names a nested SSH target.
const REFUSED_ROWS = [
  ['executionHostId only', { executionHostId: 'ssh:gpu' }, new SshHostNotServedError('gpu')],
  ['legacy connectionId', { connectionId: 'gpu' }, new SshHostNotServedError('gpu')],
  [
    'local with a stale connectionId',
    { executionHostId: 'local', connectionId: 'gpu' },
    new SshHostNotServedError('gpu')
  ],
  [
    'runtime host with a nested SSH target',
    { executionHostId: 'runtime:env', connectionId: 'gpu' },
    new SshHostNotServedError('gpu')
  ]
] as const

describe('runtime PR/MR worktree base runs Git only for rows on this machine', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'origin\n', stderr: '' })
  })

  for (const [provider, resolveBase] of PROVIDERS) {
    it.each(REFUSED_ROWS)(`${provider} refuses a row: %s`, async (_label, fields, expected) => {
      await expect(resolveBase(async () => repoOn(fields))).rejects.toEqual(expected)
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    })

    // Why runtime: older servers kept the client-minted `runtime:<id>` stamp on rows they own.
    it.each([
      ['local', { executionHostId: 'local' }],
      ['runtime-stamped on this server', { executionHostId: 'runtime:env' }]
    ] as const)(`${provider} runs local Git for a row here: %s`, async (_label, fields) => {
      await resolveBase(async () => repoOn(fields)).catch(() => {})
      expect(gitExecFileAsyncMock).toHaveBeenCalled()
    })
  }
})
