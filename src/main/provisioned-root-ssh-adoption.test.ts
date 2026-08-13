import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { AdoptProvisionedRootArgs, GitWorktreeInfo, Repo, WorktreeMeta } from '../shared/types'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import { registerSshGitProvider, unregisterSshGitProvider } from './providers/ssh-git-dispatch'
import {
  resetSshProviderAuthorities,
  rotateSshProviderAuthority
} from './ssh/ssh-provider-authority'
import { adoptProvisionedRootSshCheckout } from './provisioned-root-ssh-adoption'

const connectionId = 'runtime-ssh-test'
const projectRoot = '/workspace/orca'

describe('adoptProvisionedRootSshCheckout', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-provisioned-root-'))
    resetSshProviderAuthorities()
  })

  afterEach(() => {
    unregisterSshGitProvider(connectionId)
    resetSshProviderAuthorities()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('adopts the exact primary checkout, persists host metadata, and attaches the runtime', async () => {
    seedRuntime(userDataPath, projectRoot)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree(projectRoot)])
    } as never)
    const { store, setWorktreeMeta } = makeStore()

    const result = await adoptProvisionedRootSshCheckout({
      userDataPath,
      request: request(projectRoot),
      repo: repo(projectRoot),
      store,
      isRepoCurrent: () => true
    })

    expect(result.worktree).toMatchObject({
      id: `repo-1::${projectRoot}`,
      path: projectRoot,
      isMainWorktree: true,
      hostId: `ssh:${connectionId}`,
      ephemeralVmCheckoutMode: 'provisioned-root',
      linkedGitLabIssue: 17
    })
    expect(setWorktreeMeta).toHaveBeenCalledWith(
      `repo-1::${projectRoot}`,
      expect.objectContaining({
        hostId: `ssh:${connectionId}`,
        ephemeralVmCheckoutMode: 'provisioned-root',
        linkedGitLabIssue: 17
      })
    )
    expect(listEphemeralVmRuntimes(userDataPath)[0]).toMatchObject({
      workspaceId: `repo-1::${projectRoot}`,
      status: 'running'
    })
  })

  it('rejects a linked worktree and sparse checkout', async () => {
    seedRuntime(userDataPath, projectRoot)
    const listWorktrees = vi
      .fn()
      .mockResolvedValue([gitWorktree(projectRoot, { isMainWorktree: false })])
    registerSshGitProvider(connectionId, { listWorktrees } as never)
    const { store, setWorktreeMeta } = makeStore()

    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request(projectRoot),
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('must be the repository primary checkout')
    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: { ...request(projectRoot), sparseCheckout: { directories: ['src'] } },
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('do not support sparse checkout')
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('rejects path and runtime target mismatches', async () => {
    seedRuntime(userDataPath, projectRoot)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree(projectRoot)])
    } as never)
    const { store } = makeStore()

    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request('/workspace/other'),
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('does not match')
    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: { ...request(projectRoot), executionHostId: 'ssh:runtime-ssh-other' },
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('host does not match')
  })

  it('rejects provider rotation during verification', async () => {
    seedRuntime(userDataPath, projectRoot)
    let resolveList: (value: ReturnType<typeof gitWorktree>[]) => void = () => undefined
    const listWorktrees = vi.fn(
      () =>
        new Promise<ReturnType<typeof gitWorktree>[]>((resolve) => {
          resolveList = resolve
        })
    )
    registerSshGitProvider(connectionId, { listWorktrees } as never)
    const { store } = makeStore()
    const adoption = adoptProvisionedRootSshCheckout({
      userDataPath,
      request: request(projectRoot),
      repo: repo(projectRoot),
      store,
      isRepoCurrent: () => true
    })
    await vi.waitFor(() => expect(listWorktrees).toHaveBeenCalledOnce())
    rotateSshProviderAuthority(connectionId)
    resolveList([gitWorktree(projectRoot)])

    await expect(adoption).rejects.toThrow('changed during checkout verification')
  })

  it('compares Windows checkout roots using runtime path semantics', async () => {
    const windowsRoot = 'C:\\Workspace\\Orca'
    seedRuntime(userDataPath, windowsRoot)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree('c:/workspace/orca/')])
    } as never)
    const { store } = makeStore()

    const result = await adoptProvisionedRootSshCheckout({
      userDataPath,
      request: request('C:/WORKSPACE/ORCA'),
      repo: repo('c:\\workspace\\orca'),
      store,
      isRepoCurrent: () => true
    })

    expect(result.worktree.path).toBe('c:/workspace/orca/')
  })
})

function seedRuntime(userDataPath: string, root: string): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-1',
    recipeId: 'sandbox',
    recipe: {
      id: 'sandbox',
      name: 'Sandbox',
      create: 'sandbox create',
      checkoutMode: 'provisioned-root'
    },
    connectionMode: 'ssh',
    sshTargetId: connectionId,
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        target: { label: 'Sandbox', host: '127.0.0.1', port: 22, username: 'orca' },
        projectRoot: root
      }
    }
  })
}

function repo(path: string): Repo {
  return {
    id: 'repo-1',
    path,
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: 1,
    connectionId,
    executionHostId: `ssh:${connectionId}`
  }
}

function request(expectedPath: string): AdoptProvisionedRootArgs {
  return {
    repoId: 'repo-1',
    name: 'fix-sandbox',
    runtimeId: 'runtime-1',
    executionHostId: `ssh:${connectionId}`,
    expectedPath,
    linkedGitLabIssue: 17
  }
}

function gitWorktree(path: string, overrides: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: 'refs/heads/fix-sandbox',
    isBare: false,
    isMainWorktree: true,
    ...overrides
  }
}

function makeStore(): {
  store: Store
  setWorktreeMeta: ReturnType<typeof vi.fn>
} {
  const setWorktreeMeta = vi.fn((_: string, updates: Partial<WorktreeMeta>) => ({
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...updates
  }))
  return {
    store: {
      getSettings: () => ({ nestWorkspaces: false, workspaceDir: '.orca/worktrees' }),
      setWorktreeMeta
    } as unknown as Store,
    setWorktreeMeta
  }
}
