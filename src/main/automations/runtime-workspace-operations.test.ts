import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { DetectedWorktreeListResult } from '../../shared/worktree/types'
import { mergeWorktree } from '../ipc/worktree-logic'
import { createRuntimeAutomationWorkspaceOperations } from './runtime-workspace-operations'

const ssh = vi.hoisted(() => ({ connect: vi.fn(), state: vi.fn(), needsCredentials: vi.fn() }))
vi.mock('../ssh/ssh-target-registry', () => ({
  connectRegisteredSshTarget: ssh.connect,
  getRegisteredSshState: ssh.state,
  registeredSshTargetNeedsInteractiveCredentials: ssh.needsCredentials
}))

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1
}
const worktree = mergeWorktree(
  repo.id,
  {
    path: '/repo/workspace',
    head: 'abc',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false
  },
  undefined,
  repo.displayName
)

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Checks',
    prompt: 'Check changes',
    agentId: 'codex',
    precheck: null,
    projectId: repo.id,
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: worktree.id,
    workspaceRecovery: { kind: 'worktree', baseBranch: 'origin/main' },
    baseBranch: null,
    reuseSession: true,
    enabled: true,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    nextRunAt: 1,
    createdAt: 0,
    updatedAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    ...overrides
  }
}

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'auto-1',
  title: 'Checks run 1',
  scheduledFor: 0,
  status: 'dispatching',
  trigger: 'manual',
  workspaceId: worktree.id,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 0
}

function fixture(targetRepo = repo) {
  const listing: DetectedWorktreeListResult = {
    repoId: targetRepo.id,
    authoritative: true,
    source: 'git',
    worktrees: [{ ...worktree, ownership: 'orca-managed', selectedCheckout: false, visible: true }]
  }
  const runtime = {
    listDetectedManagedWorktrees: vi.fn(async () => listing),
    invalidateWorktreeCatalog: vi.fn(),
    createManagedWorktree: vi.fn<
      Parameters<typeof createRuntimeAutomationWorkspaceOperations>[0]['createManagedWorktree']
    >(async () => ({ worktree })),
    createFolderWorkspace:
      vi.fn<
        Parameters<typeof createRuntimeAutomationWorkspaceOperations>[0]['createFolderWorkspace']
      >()
  }
  const store = {
    getFolderWorkspaces: vi.fn<() => FolderWorkspace[]>(() => []),
    getProjectGroups: vi.fn<() => ProjectGroup[]>(() => []),
    getRepos: () => [targetRepo]
  }
  const operations = createRuntimeAutomationWorkspaceOperations(runtime, store)
  const target = { ok: true as const, cwd: targetRepo.path, repo: targetRepo }
  return { runtime, store, operations, target, listing }
}

beforeEach(() => {
  vi.clearAllMocks()
  ssh.state.mockReturnValue({ status: 'connected' })
  ssh.needsCredentials.mockReturnValue(false)
  ssh.connect.mockResolvedValue({ status: 'connected' })
})

describe('runtime automation workspace verification', () => {
  it('refreshes only the selected repository and finds a workspace regardless of UI visibility', async () => {
    const f = fixture()
    f.listing.worktrees[0].visible = false
    expect(await f.operations.probe(automation(), f.target)).toMatchObject({
      kind: 'available',
      workspace: { id: worktree.id }
    })
    expect(f.runtime.invalidateWorktreeCatalog).toHaveBeenCalledWith(repo.id)
    expect(f.runtime.listDetectedManagedWorktrees).toHaveBeenCalledWith('id:repo-1', null)
  })

  it('requires authoritative absence, even if a failed scan returns an empty list', async () => {
    const f = fixture()
    f.listing.authoritative = false
    f.listing.worktrees = []
    expect(await f.operations.probe(automation(), f.target)).toMatchObject({ kind: 'unverifiable' })
    expect(f.runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('treats a prunable registration as missing but never replaces a workspace still being removed', async () => {
    const f = fixture()
    f.listing.worktrees[0].prunable = true
    expect(await f.operations.probe(automation(), f.target)).toEqual({ kind: 'missing' })
    f.listing.worktrees[0].removing = true
    expect(await f.operations.probe(automation(), f.target)).toMatchObject({ kind: 'unverifiable' })
  })

  it('reconnects an executionHostId-only SSH target before scanning that host', async () => {
    const f = fixture({ ...repo, executionHostId: 'ssh:host-1' })
    ssh.state.mockReturnValue({ status: 'disconnected' })
    const order: string[] = []
    ssh.connect.mockImplementation(async () => {
      order.push('connect')
      return { status: 'connected' }
    })
    f.runtime.listDetectedManagedWorktrees.mockImplementation(async () => {
      order.push('scan')
      return f.listing
    })
    await f.operations.probe(automation(), f.target)
    expect(order).toEqual(['connect', 'scan'])
    expect(f.runtime.listDetectedManagedWorktrees).toHaveBeenCalledWith('id:repo-1', 'host-1')
  })

  it('does not scan or create when SSH needs interactive credentials', async () => {
    const f = fixture({ ...repo, connectionId: 'host-1' })
    ssh.state.mockReturnValue({ status: 'disconnected' })
    ssh.needsCredentials.mockReturnValue(true)
    expect(await f.operations.probe(automation(), f.target)).toMatchObject({
      kind: 'unverifiable',
      status: 'skipped_needs_interactive_auth'
    })
    expect(ssh.connect).not.toHaveBeenCalled()
    expect(f.runtime.listDetectedManagedWorktrees).not.toHaveBeenCalled()
  })

  it('creates from the saved base without launching an agent before the new target is saved', async () => {
    const f = fixture()
    await f.operations.create(automation(), run, f.target)
    expect(f.runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: repo.id,
        baseBranch: 'origin/main',
        setupDecision: 'skip',
        activate: false,
        automationProvenance: expect.objectContaining({
          automationId: 'auto-1',
          automationRunId: run.id
        })
      })
    )
    const args = f.runtime.createManagedWorktree.mock.calls[0]?.[0]
    expect(args).not.toHaveProperty('startupAgent')
    expect(args).not.toHaveProperty('createdWithAgent')
    expect(args).not.toHaveProperty('startupPrompt')
  })

  it('recreates a folder registration at its captured path', async () => {
    const f = fixture()
    const captured = automation({
      workspaceId: 'folder:gone',
      workspaceRecovery: {
        kind: 'folder',
        projectGroupId: 'group-1',
        folderPath: '/repo',
        connectionId: null
      }
    })
    f.runtime.createFolderWorkspace.mockResolvedValue({
      id: 'replacement',
      projectGroupId: 'group-1',
      folderPath: '/repo',
      connectionId: null,
      name: 'Checks',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    })
    expect(await f.operations.probe(captured, f.target)).toEqual({ kind: 'missing' })
    expect(await f.operations.create(captured, run, f.target)).toEqual({
      id: 'folder:replacement',
      displayName: 'Checks'
    })
    expect(f.runtime.createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      folderPath: '/repo',
      connectionId: null,
      name: 'Checks'
    })
    expect(f.runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('refuses a host substitution when recreating a folder registration', async () => {
    const f = fixture()
    const captured = automation({
      workspaceId: 'folder:gone',
      workspaceRecovery: {
        kind: 'folder',
        projectGroupId: 'group-1',
        folderPath: '/repo',
        connectionId: 'other-host'
      }
    })
    await expect(f.operations.probe(captured, f.target)).rejects.toThrow('different host')
    await expect(f.operations.create(captured, run, f.target)).rejects.toThrow('different host')
    expect(f.runtime.createFolderWorkspace).not.toHaveBeenCalled()
  })
})
