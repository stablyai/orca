import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

const mocks = vi.hoisted(() => ({
  connectRegisteredSshTarget: vi.fn(),
  upsertRuntimeOwnedTarget: vi.fn(),
  removeRegisteredSshTarget: vi.fn(),
  disconnectRegisteredSshTarget: vi.fn(),
  getRegisteredSshState: vi.fn(),
  getSshGitProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn(),
  getSshPtyProvider: vi.fn()
}))

vi.mock('./ipc/ssh', () => ({
  connectRegisteredSshTarget: mocks.connectRegisteredSshTarget,
  getSshConnectionStore: () => ({ upsertRuntimeOwnedTarget: mocks.upsertRuntimeOwnedTarget })
}))
vi.mock('./ipc/ssh-session-teardown', () => ({
  removeRegisteredSshTarget: mocks.removeRegisteredSshTarget,
  disconnectRegisteredSshTarget: mocks.disconnectRegisteredSshTarget
}))
vi.mock('./ssh/ssh-target-registry', () => ({
  getRegisteredSshState: mocks.getRegisteredSshState
}))
vi.mock('./providers/ssh-git-dispatch', () => ({ getSshGitProvider: mocks.getSshGitProvider }))
vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))
vi.mock('./ipc/pty/provider/registry', () => ({ getSshPtyProvider: mocks.getSshPtyProvider }))

import {
  connectRuntimeOwnedSshTarget,
  getRuntimeOwnedSshRelayState,
  reattachRuntimeOwnedSshTarget
} from './ephemeral-vm-runtime-ssh'

const TARGET_ID = 'runtime-ssh-orca-1'
const connection = {
  type: 'ssh' as const,
  projectRoot: '/sandbox/project',
  target: { label: 'VM', host: '127.0.0.1', port: 2222, username: 'root' }
}
const runtime = {
  id: 'orca-1',
  recipeId: 'sandbox',
  status: 'running',
  cleanupStatus: 'not_started',
  connectionMode: 'ssh',
  sshTargetId: TARGET_ID,
  createdAt: 1,
  updatedAt: 1,
  recipeResult: { schemaVersion: 1, connection }
} as EphemeralVmRuntimeRecord & { sshTargetId: string }

beforeEach(() => {
  vi.useFakeTimers()
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.upsertRuntimeOwnedTarget.mockImplementation((runtimeId: string, target: object) => ({
    ...target,
    id: `runtime-ssh-${runtimeId}`
  }))
  mocks.connectRegisteredSshTarget.mockResolvedValue({ targetId: TARGET_ID, status: 'connected' })
  mocks.removeRegisteredSshTarget.mockResolvedValue(undefined)
  mocks.getSshGitProvider.mockReturnValue({})
  mocks.getSshFilesystemProvider.mockReturnValue({})
  mocks.getSshPtyProvider.mockReturnValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('connectRuntimeOwnedSshTarget', () => {
  it('waits for the PTY provider as well as git and filesystem before reporting ready', async () => {
    // Why: a terminal spawn right after connect used to race the relay's PTY provider registration.
    let ptyReady = false
    mocks.getSshPtyProvider.mockImplementation(() => (ptyReady ? {} : undefined))
    let settled = false
    const pending = connectRuntimeOwnedSshTarget({ runtimeId: 'orca-1', connection }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)
    ptyReady = true
    await vi.advanceTimersByTimeAsync(200)
    await pending
    expect(settled).toBe(true)
  })

  it('removes the freshly persisted target when the providers never become ready', async () => {
    mocks.getSshPtyProvider.mockReturnValue(undefined)
    const pending = connectRuntimeOwnedSshTarget({ runtimeId: 'orca-1', connection })
    const rejection = expect(pending).rejects.toThrow('SSH relay providers were not ready')
    await vi.advanceTimersByTimeAsync(11_000)
    await rejection
    expect(mocks.removeRegisteredSshTarget).toHaveBeenCalledWith(TARGET_ID)
  })
})

describe('getRuntimeOwnedSshRelayState', () => {
  it.each([
    ['attached', 'connected', {}],
    ['detached', 'connected', undefined],
    ['reconnecting', 'reconnecting', undefined],
    ['detached', 'disconnected', undefined],
    ['detached', undefined, undefined]
  ] as const)('reads %s from status=%s', (expected, status, ptyProvider) => {
    mocks.getRegisteredSshState.mockReturnValue(status ? { status } : undefined)
    mocks.getSshPtyProvider.mockReturnValue(ptyProvider)
    expect(getRuntimeOwnedSshRelayState(TARGET_ID)).toBe(expected)
  })
})

describe('reattachRuntimeOwnedSshTarget', () => {
  it('re-upserts the target row from the recipe result and dials it when detached', async () => {
    mocks.getRegisteredSshState.mockReturnValue(undefined)
    await reattachRuntimeOwnedSshTarget(runtime)
    expect(mocks.upsertRuntimeOwnedTarget).toHaveBeenCalledWith('orca-1', connection.target)
    expect(mocks.connectRegisteredSshTarget).toHaveBeenCalledWith(TARGET_ID)
  })

  it('keeps the target row when the dial fails, unlike the provisioning connect', async () => {
    // Why: the VM is still recorded as running, so the workspace must keep pointing at
    // its target for the next activation or spawn to retry.
    mocks.getRegisteredSshState.mockReturnValue(undefined)
    mocks.connectRegisteredSshTarget.mockResolvedValue({
      targetId: TARGET_ID,
      status: 'error',
      error: 'connect ECONNREFUSED'
    })
    await expect(reattachRuntimeOwnedSshTarget(runtime)).rejects.toThrow('ECONNREFUSED')
    expect(mocks.removeRegisteredSshTarget).not.toHaveBeenCalled()
  })

  it('does not dial an attached target', async () => {
    mocks.getRegisteredSshState.mockReturnValue({ status: 'connected' })
    await reattachRuntimeOwnedSshTarget(runtime)
    expect(mocks.connectRegisteredSshTarget).not.toHaveBeenCalled()
    expect(mocks.upsertRuntimeOwnedTarget).not.toHaveBeenCalled()
  })

  it('refuses to dial over a relay that is reconnecting on its own', async () => {
    mocks.getRegisteredSshState.mockReturnValue({ status: 'reconnecting' })
    await expect(reattachRuntimeOwnedSshTarget(runtime)).rejects.toThrow('still reconnecting')
    expect(mocks.connectRegisteredSshTarget).not.toHaveBeenCalled()
  })

  it('waits for providers instead of redialing a connected transport', async () => {
    mocks.getRegisteredSshState.mockReturnValue({ status: 'connected' })
    let ptyReady = false
    mocks.getSshPtyProvider.mockImplementation(() => (ptyReady ? {} : undefined))
    const pending = reattachRuntimeOwnedSshTarget(runtime)
    await vi.advanceTimersByTimeAsync(300)
    ptyReady = true
    await vi.advanceTimersByTimeAsync(200)
    await pending
    expect(mocks.connectRegisteredSshTarget).not.toHaveBeenCalled()
  })
})
