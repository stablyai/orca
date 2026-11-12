import { describe, expect, it, vi, type Mock } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../../shared/worktree/types'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'

type ExecMock = Mock<GitRemoteExec>

const REPO_PATH = '/repo-root'
const FORK_URL = 'git@github.com:contributor/orca.git'
const FORK_REMOTE = 'pr-contributor-orca'

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: FORK_REMOTE,
    branchName: 'contributor/fix',
    remoteUrl: FORK_URL,
    remoteCreated: true,
    ...overrides
  }
}

function metaWith(pushTarget: GitPushTarget | undefined): WorktreeMeta {
  return { pushTarget } as unknown as WorktreeMeta
}

function storeOf(entries: Record<string, GitPushTarget | undefined>): WorktreePushTargetStore {
  const meta: Record<string, WorktreeMeta> = {}
  for (const [id, pushTarget] of Object.entries(entries)) {
    meta[id] = metaWith(pushTarget)
  }
  return { getAllWorktreeMeta: () => meta }
}

type ExecScript = {
  branchConfig?: string
  getUrl?: string
  getUrlThrows?: boolean
}

function makeExec(script: ExecScript = {}): ExecMock {
  const { branchConfig = '', getUrl = FORK_URL, getUrlThrows = false } = script
  return vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'config') {
      return { stdout: branchConfig, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      if (getUrlThrows) {
        throw new Error('No such remote')
      }
      return { stdout: `${getUrl}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'remove') {
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

function removeCalls(exec: ExecMock): string[][] {
  return exec.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === 'remote' && args[1] === 'remove')
}

describe('cleanupUnusedWorktreePushTargetRemoteWithExec', () => {
  it('keeps a remote Orca did not create (remoteCreated falsy)', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget({ remoteCreated: false }),
      storeOf({ 'repo-1::/wt/a': forkTarget({ remoteCreated: false }) }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
    // Deferred materialization can omit store ownership; cleanup must also inspect Git config provenance.
    expect(exec).toHaveBeenCalledWith(
      ['config', '--get', `remote.${FORK_REMOTE}.orca-created`],
      REPO_PATH
    )
  })

  it('never touches origin or upstream', async () => {
    for (const remoteName of ['origin', 'upstream']) {
      const exec = makeExec()
      await cleanupUnusedWorktreePushTargetRemoteWithExec(
        REPO_PATH,
        'repo-1::/wt/a',
        forkTarget({ remoteName }),
        storeOf({}),
        exec
      )
      expect(removeCalls(exec)).toEqual([])
    }
  })

  it('keeps the remote when another worktree in the same repo uses the same remote name (multi-fork)', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        'repo-1::/wt/b': forkTarget({ branchName: 'contributor/other' })
      }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('keeps the remote when a branch config still tracks it', async () => {
    const exec = makeExec({
      branchConfig: `branch.contributor/fix.remote ${FORK_REMOTE}`
    })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('keeps the remote when its URL no longer matches the fork (repurposed by the user)', async () => {
    const exec = makeExec({ getUrl: 'git@github.com:someone-else/orca.git' })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })
})
