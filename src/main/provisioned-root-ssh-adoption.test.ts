import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type { AdoptProvisionedRootArgs } from '../shared/worktree/create-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import { adoptProvisionedRootSshCheckout } from './provisioned-root-ssh-adoption'

const connectionId = 'runtime-ssh-test'
const projectRoot = '/workspace/orca'

describe('adoptProvisionedRootSshCheckout', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-provisioned-root-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('refuses a valid request because this process serves no SSH git, without writing state', async () => {
    seedRuntime(userDataPath, projectRoot)
    const { store, setWorktreeMeta } = makeStore()

    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request(projectRoot),
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('no longer available')
    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(listEphemeralVmRuntimes(userDataPath)[0]?.workspaceId).toBeUndefined()
  })

  it('rejects sparse checkout requests', async () => {
    seedRuntime(userDataPath, projectRoot)
    const { store } = makeStore()

    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: { ...request(projectRoot), sparseCheckout: { directories: ['src'] } },
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('do not support sparse checkout')
  })

  it('rejects path and runtime target mismatches', async () => {
    seedRuntime(userDataPath, projectRoot)
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
