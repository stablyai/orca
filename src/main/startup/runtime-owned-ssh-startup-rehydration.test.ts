import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'

const { ensureRuntimeOwnedSshConnectionMock } = vi.hoisted(() => ({
  ensureRuntimeOwnedSshConnectionMock: vi.fn()
}))

vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  ensureRuntimeOwnedSshConnection: ensureRuntimeOwnedSshConnectionMock
}))

import {
  rehydrateRuntimeOwnedSshForRestoredWorkspaces,
  STARTUP_SSH_REHYDRATION_BARRIER_BUDGET_MS
} from './runtime-owned-ssh-startup-rehydration'

const tempDirs: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A store whose persisted sessions name the workspaces startup will restore. */
function makeStore(activeWorkspaceIdsByHostId: Record<string, string[]>) {
  return {
    getWorkspaceSessionHostIds: vi.fn(() => Object.keys(activeWorkspaceIdsByHostId)),
    getWorkspaceSession: vi.fn((hostId?: string | null) => {
      const ids = activeWorkspaceIdsByHostId[hostId ?? 'local'] ?? []
      return {
        activeWorktreeId: ids[0] ?? null,
        activeWorktreeIdsOnShutdown: ids
      }
    })
  }
}

function seedRuntime(
  userDataPath: string,
  overrides: Partial<EphemeralVmRuntimeRecord> & { id: string }
): void {
  upsertEphemeralVmRuntime(userDataPath, {
    recipeId: 'agent-sandbox',
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    status: 'running',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: `runtime-ssh-${overrides.id}`,
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: { label: 'Agent Sandbox', host: '127.0.0.1', port: 2222, username: 'orca' }
      }
    },
    ...overrides
  })
}

describe('rehydrateRuntimeOwnedSshForRestoredWorkspaces', () => {
  beforeEach(() => {
    ensureRuntimeOwnedSshConnectionMock.mockReset()
    ensureRuntimeOwnedSshConnectionMock.mockResolvedValue('runtime-ssh-instance-1')
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ensures the SSH connection for a runtime-owned workspace startup restores as active', async () => {
    const userDataPath = makeDir('orca-startup-rehydrate-')
    seedRuntime(userDataPath, { id: 'instance-1', workspaceId: 'workspace-1' })

    await rehydrateRuntimeOwnedSshForRestoredWorkspaces({
      store: makeStore({ 'ssh:runtime-ssh-instance-1': ['workspace-1'] }) as never,
      userDataPath
    })

    expect(ensureRuntimeOwnedSshConnectionMock).toHaveBeenCalledTimes(1)
    expect(ensureRuntimeOwnedSshConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: expect.objectContaining({ id: 'instance-1' }) })
    )
  })

  it('leaves a runtime alone when no restored session names its workspace', async () => {
    const userDataPath = makeDir('orca-startup-rehydrate-idle-')
    seedRuntime(userDataPath, { id: 'instance-1', workspaceId: 'workspace-1' })

    await rehydrateRuntimeOwnedSshForRestoredWorkspaces({
      store: makeStore({ local: ['some-other-workspace'] }) as never,
      userDataPath
    })

    expect(ensureRuntimeOwnedSshConnectionMock).not.toHaveBeenCalled()
  })

  it('keeps a runtime retryable when its reconnect fails', async () => {
    // Why: an unreachable endpoint is `unverifiable`, never evidence the sandbox exited.
    // Startup must neither throw nor downgrade the record.
    const userDataPath = makeDir('orca-startup-rehydrate-fail-')
    seedRuntime(userDataPath, { id: 'instance-1', workspaceId: 'workspace-1' })
    ensureRuntimeOwnedSshConnectionMock.mockRejectedValue(new Error('connect ECONNREFUSED'))

    await expect(
      rehydrateRuntimeOwnedSshForRestoredWorkspaces({
        store: makeStore({ 'ssh:runtime-ssh-instance-1': ['workspace-1'] }) as never,
        userDataPath
      })
    ).resolves.toBeUndefined()

    const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === 'instance-1')
    expect(runtime).toEqual(
      expect.objectContaining({ status: 'running', cleanupStatus: 'not_started' })
    )
  })

  it('releases the startup barrier instead of waiting out an unreachable sandbox', async () => {
    // Why: this gates every restored terminal, local ones included, and an SSH connect can take
    // 30s before it even reaches the provider wait.
    const userDataPath = makeDir('orca-startup-rehydrate-slow-')
    seedRuntime(userDataPath, { id: 'instance-1', workspaceId: 'workspace-1' })
    ensureRuntimeOwnedSshConnectionMock.mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const pending = rehydrateRuntimeOwnedSshForRestoredWorkspaces({
        store: makeStore({ 'ssh:runtime-ssh-instance-1': ['workspace-1'] }) as never,
        userDataPath
      })
      const settled = pending.then(() => 'released' as const)
      await vi.advanceTimersByTimeAsync(STARTUP_SSH_REHYDRATION_BARRIER_BUDGET_MS + 1)

      await expect(settled).resolves.toBe('released')
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips runtimes that are already cleaned up', async () => {
    const userDataPath = makeDir('orca-startup-rehydrate-cleaned-')
    seedRuntime(userDataPath, {
      id: 'instance-1',
      workspaceId: 'workspace-1',
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })

    await rehydrateRuntimeOwnedSshForRestoredWorkspaces({
      store: makeStore({ 'ssh:runtime-ssh-instance-1': ['workspace-1'] }) as never,
      userDataPath
    })

    expect(ensureRuntimeOwnedSshConnectionMock).not.toHaveBeenCalled()
  })
})
