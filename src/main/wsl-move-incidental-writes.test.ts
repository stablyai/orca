import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../shared/worktree/types'
import type { ExecutionHostId } from '../shared/execution-host'
import { mergeWorktreeMetaForWrite } from './persistence/loading-store/worktree-meta-write-normalization'
import { wslMoveCutoverFixture as cutover } from './persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from './persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from './persistence/moving-wsl-projects/wsl-move-scope-guard'
import type * as LinearCommandDependencies from './runtime/runtime-linear-command-dependencies'
import type { ResolvedWorktree } from './runtime/runtime-worktree-path-identity'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('./git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('./runtime/runtime-linear-command-dependencies', async (importOriginal) => ({
  ...(await importOriginal<typeof LinearCommandDependencies>()),
  resolveLegacyLinearLinkWorkspace: () => ({ workspaceId: 'ws-1', organizationUrlKey: 'acme' })
}))

import { materializeWorktreePushTargetRemote } from './ipc/worktree-remote'
import { RuntimeLinearTeamWriteCommands } from './runtime/runtime-linear-team-write-commands'

const MOVING_WT = 'repo-1::/ws/repo-1/wt'
const STAYING_WT = 'repo-2::/ws/repo-2/wt'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-incidental-'))
  loadWslMoveFence(userDataPath)
  seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      throw new Error('No such remote')
    }
    return { stdout: '', stderr: '' }
  })
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('push-target bookkeeping under a WSL move', () => {
  const target: GitPushTarget = {
    remoteName: 'pr-contributor-orca',
    branchName: 'contributor/fix',
    remoteUrl: 'git@github.com:contributor/orca.git'
  }

  async function push(worktreeId: string, hostId?: ExecutionHostId) {
    const setWorktreeMeta = vi.fn()
    const meta = hostId ? { [worktreeId]: mergeWorktreeMetaForWrite(undefined, { hostId }) } : {}
    const store = { getAllWorktreeMeta: () => meta, setWorktreeMeta }
    const result = await materializeWorktreePushTargetRemote(
      '/ws/repo',
      target,
      store,
      undefined,
      {},
      worktreeId
    )
    return { result, setWorktreeMeta }
  }

  it('still pushes the moving worktree but skips its metadata write', async () => {
    const { result, setWorktreeMeta } = await push(MOVING_WT)
    expect(result).toEqual({ ...target, remoteCreated: true })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it.each<[string, string, ExecutionHostId | undefined]>([
    ['a project the move is not taking', STAYING_WT, undefined],
    ['the same repo id on another host', MOVING_WT, 'ssh:target-1']
  ])('records the push target for %s', async (_label, worktreeId, hostId) => {
    const { setWorktreeMeta } = await push(worktreeId, hostId)
    expect(setWorktreeMeta).toHaveBeenCalledWith(worktreeId, {
      pushTarget: { ...target, remoteCreated: true }
    })
  })
})

describe('Linear workspace backfill under a WSL move', () => {
  function worktree(id: string, hostId: ExecutionHostId): ResolvedWorktree {
    const path = id.slice(id.indexOf('::') + 2)
    return {
      id,
      repoId: id.slice(0, id.indexOf('::')),
      hostId,
      path,
      head: 'abc',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: false,
      displayName: 'wt',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: 'ACME-1',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path, head: 'abc', branch: 'refs/heads/main', isBare: false, isMainWorktree: false }
    }
  }

  async function resolveCurrent(row: ResolvedWorktree) {
    const setWorktreeMeta = vi.fn()
    const commands = new RuntimeLinearTeamWriteCommands({
      runtimeAvailable: () => true,
      showTerminal: async () => {
        throw new Error('unused')
      },
      resolveWorktreeSelector: async () => row,
      listResolvedWorktrees: async () => [row],
      setWorktreeMeta,
      emitClientEvent: () => {}
    })
    const link = await commands.linearResolveCurrentIssue({ cwd: row.path })
    return { link, setWorktreeMeta }
  }

  it('answers for the moving worktree without persisting the backfill', async () => {
    const { link, setWorktreeMeta } = await resolveCurrent(worktree(MOVING_WT, 'local'))
    expect(link.workspaceId).toBe('ws-1')
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it.each<[string, string, ExecutionHostId]>([
    ['a project the move is not taking', STAYING_WT, 'local'],
    ['the same repo id on another host', MOVING_WT, 'ssh:target-1']
  ])('persists the backfill for %s', async (_label, id, hostId) => {
    const { setWorktreeMeta } = await resolveCurrent(worktree(id, hostId))
    expect(setWorktreeMeta).toHaveBeenCalledWith(id, {
      linkedLinearIssueWorkspaceId: 'ws-1',
      linkedLinearIssueOrganizationUrlKey: 'acme'
    })
  })
})
