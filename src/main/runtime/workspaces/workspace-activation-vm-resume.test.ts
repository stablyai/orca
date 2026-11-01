// Activating a suspended recipe VM workspace must wake the VM on the host itself, without the
// window's resume IPC (#36923): headless serve, paired clients and the CLI never had a window to click.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../git/worktree', () => {
  const worktrees = [
    { path: '/tmp/host', head: 'host', branch: 'host', isBare: false, isMainWorktree: false }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

import { OrcaRuntimeService } from '../orca-runtime'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

const WORKTREE_ID = 'repo-1::/tmp/host'

function makeStore() {
  const worktreeMeta: Record<string, WorktreeMeta> = {
    [WORKTREE_ID]: {
      displayName: 'host',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      instanceId: WORKTREE_ID
    }
  }
  const repo: Repo = {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  return {
    getRepo: (id: string) => (id === repo.id ? repo : null),
    getRepos: () => [repo],
    addRepo: () => {},
    updateRepo: () => null,
    getAllWorktreeMeta: () => worktreeMeta,
    getWorktreeMeta: (id: string) => worktreeMeta[id],
    setWorktreeMeta: ({ id }: HostWorktreeTarget, patch: Partial<WorktreeMeta>) => {
      const next = { ...worktreeMeta[id]!, ...patch }
      worktreeMeta[id] = next
      return next
    },
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
}

function serviceWithVmPlatform(resumeVm: (workspaceId: string) => Promise<void>) {
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    workspaceSleepPlatform: {
      callEnvironment: vi.fn(async () => {
        throw new Error('no paired servers')
      }),
      suspendVm: vi.fn(async () => {}),
      resumeVm
    }
  } as never)
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.attachWindow(1)
  runtime.markGraphReady(1)
  return runtime
}

describe('activateManagedWorktree VM wake', () => {
  it('resumes a suspended recipe VM on the host when the workspace activates', async () => {
    const resumeVm = vi.fn(async () => {})
    const runtime = serviceWithVmPlatform(resumeVm)

    await expect(runtime.activateManagedWorktree(`id:${WORKTREE_ID}`)).resolves.toMatchObject({
      worktreeId: WORKTREE_ID,
      activated: true
    })

    // The wake is queued fire-and-forget (it can outlast activation timeouts), so poll for it.
    await vi.waitFor(() => expect(resumeVm).toHaveBeenCalledWith(WORKTREE_ID))
  })
})
