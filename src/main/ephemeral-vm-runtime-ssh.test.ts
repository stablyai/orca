import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

const {
  connectRegisteredSshTargetMock,
  getSshConnectionStoreMock,
  upsertRuntimeOwnedTargetMock,
  disconnectRegisteredSshTargetMock,
  removeRegisteredSshTargetMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  getSshPtyProviderMock
} = vi.hoisted(() => ({
  connectRegisteredSshTargetMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn(),
  upsertRuntimeOwnedTargetMock: vi.fn(),
  disconnectRegisteredSshTargetMock: vi.fn(),
  removeRegisteredSshTargetMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn(),
  getSshPtyProviderMock: vi.fn()
}))

vi.mock('./ipc/ssh', () => ({
  connectRegisteredSshTarget: connectRegisteredSshTargetMock,
  getSshConnectionStore: getSshConnectionStoreMock
}))

vi.mock('./ipc/ssh-session-teardown', () => ({
  disconnectRegisteredSshTarget: disconnectRegisteredSshTargetMock,
  removeRegisteredSshTarget: removeRegisteredSshTargetMock
}))

vi.mock('./providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

vi.mock('./ipc/pty/provider/registry', () => ({
  getSshPtyProvider: getSshPtyProviderMock
}))

import { ensureRuntimeOwnedSshConnection } from './ephemeral-vm-runtime-ssh'

const TARGET_ID = 'runtime-ssh-instance-1'

function runningSshRuntime(): EphemeralVmRuntimeRecord {
  return {
    id: 'instance-1',
    recipeId: 'agent-sandbox',
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    status: 'running',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: TARGET_ID,
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: { label: 'Agent Sandbox', host: '127.0.0.1', port: 2222, username: 'orca' }
      }
    }
  }
}

describe('ensureRuntimeOwnedSshConnection', () => {
  beforeEach(() => {
    connectRegisteredSshTargetMock.mockReset()
    connectRegisteredSshTargetMock.mockResolvedValue({ status: 'connected' })
    upsertRuntimeOwnedTargetMock.mockReset()
    upsertRuntimeOwnedTargetMock.mockImplementation((runtimeId: string) => ({
      id: `runtime-ssh-${runtimeId}`,
      label: 'Agent Sandbox',
      host: '127.0.0.1',
      port: 2222,
      username: 'orca'
    }))
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockReturnValue({
      upsertRuntimeOwnedTarget: upsertRuntimeOwnedTargetMock
    })
    disconnectRegisteredSshTargetMock.mockReset()
    removeRegisteredSshTargetMock.mockReset()
    removeRegisteredSshTargetMock.mockResolvedValue(undefined)
    // A connect registers all three providers together, so the readiness wait resolves.
    getSshGitProviderMock.mockReset()
    getSshGitProviderMock.mockReturnValue({})
    getSshFilesystemProviderMock.mockReset()
    getSshFilesystemProviderMock.mockReturnValue({})
    getSshPtyProviderMock.mockReset()
  })

  it('does not reconnect a target whose PTY provider is already registered', async () => {
    // Why: a redundant connect disposes the runtime layer's live relay session.
    getSshPtyProviderMock.mockReturnValue({})

    const targetId = await ensureRuntimeOwnedSshConnection({ runtime: runningSshRuntime() })

    expect(targetId).toBe(TARGET_ID)
    expect(connectRegisteredSshTargetMock).not.toHaveBeenCalled()
    expect(upsertRuntimeOwnedTargetMock).not.toHaveBeenCalled()
  })

  it('reconnects from the persisted recipe result when this process has no PTY provider', async () => {
    // The relay registers all three providers together, so the provider appears once connect lands.
    getSshPtyProviderMock.mockImplementation(() =>
      connectRegisteredSshTargetMock.mock.calls.length > 0 ? {} : undefined
    )

    const targetId = await ensureRuntimeOwnedSshConnection({ runtime: runningSshRuntime() })

    expect(targetId).toBe(TARGET_ID)
    expect(upsertRuntimeOwnedTargetMock).toHaveBeenCalledWith('instance-1', {
      label: 'Agent Sandbox',
      host: '127.0.0.1',
      port: 2222,
      username: 'orca'
    })
    expect(connectRegisteredSshTargetMock).toHaveBeenCalledWith(TARGET_ID)
  })

  it('keeps the persisted target when the reconnect fails', async () => {
    // Why: removing the target disposes remote PTYs and drops their leases. A failed
    // reconnect is `unverifiable`, never evidence the remote runtime exited, so the
    // route must stay intact and retryable.
    getSshPtyProviderMock.mockReturnValue(undefined)
    connectRegisteredSshTargetMock.mockResolvedValue({
      status: 'error',
      error: 'connect ECONNREFUSED 127.0.0.1:2222'
    })

    await expect(ensureRuntimeOwnedSshConnection({ runtime: runningSshRuntime() })).rejects.toThrow(
      'connect ECONNREFUSED 127.0.0.1:2222'
    )
    expect(removeRegisteredSshTargetMock).not.toHaveBeenCalled()
    expect(disconnectRegisteredSshTargetMock).not.toHaveBeenCalled()
  })

  it('does not report readiness while only the git and filesystem providers are registered', async () => {
    // Why: the ensure gate keys on the PTY provider, so a connect that returns before it is
    // registered would satisfy the gate while `pty:spawn` still rejects with "No PTY provider".
    vi.useFakeTimers()
    try {
      getSshPtyProviderMock.mockReturnValue(undefined)

      const pending = ensureRuntimeOwnedSshConnection({ runtime: runningSshRuntime() })
      const settled = pending.then(
        () => 'resolved' as const,
        () => 'rejected' as const
      )
      await vi.advanceTimersByTimeAsync(9_000)
      expect(connectRegisteredSshTargetMock).toHaveBeenCalledWith(TARGET_ID)
      await vi.advanceTimersByTimeAsync(2_000)

      await expect(settled).resolves.toBe('rejected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a runtime that is not SSH-backed', async () => {
    const runtime: EphemeralVmRuntimeRecord = {
      ...runningSshRuntime(),
      connectionMode: 'orca-server',
      sshTargetId: undefined,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: 'pairing-code',
        projectRoot: '/workspace/repo'
      }
    }

    const targetId = await ensureRuntimeOwnedSshConnection({ runtime })

    expect(targetId).toBeNull()
    expect(connectRegisteredSshTargetMock).not.toHaveBeenCalled()
  })
})
