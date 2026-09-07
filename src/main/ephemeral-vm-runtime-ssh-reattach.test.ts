import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import type {
  EphemeralVmRuntimeRecord,
  EphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtimes'

const { getRelayStateMock, reattachMock } = vi.hoisted(() => ({
  getRelayStateMock: vi.fn(),
  reattachMock: vi.fn()
}))

vi.mock('./ephemeral-vm-runtime-ssh', () => ({
  getRuntimeOwnedSshRelayState: getRelayStateMock,
  reattachRuntimeOwnedSshTarget: reattachMock
}))

import {
  ensureRuntimeOwnedSshTargetAttached,
  installRuntimeOwnedSshPtyProviderRecovery,
  reattachRuntimeOwnedSshTargetsAtStartup
} from './ephemeral-vm-runtime-ssh-reattach'
import { recoverMissingSshPtyProvider } from './ipc/pty/provider/missing-ssh-pty-provider-recovery'
import { registerSshPtyProvider, unregisterSshPtyProvider } from './ipc/pty/provider/registry'

const tempDirs: string[] = []

function makeUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-vm-ssh-reattach-'))
  tempDirs.push(dir)
  return dir
}

function sshRuntime(
  id: string,
  status: EphemeralVmRuntimeStatus,
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord & { sshTargetId: string } {
  return {
    id,
    recipeId: 'sandbox',
    repoId: 'repo-1',
    workspaceId: `ws-${id}`,
    status,
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: `runtime-ssh-${id}`,
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/sandbox/project',
        target: { label: 'VM', host: '127.0.0.1', port: 2222, username: 'root' }
      }
    },
    ...overrides
  } as EphemeralVmRuntimeRecord & { sshTargetId: string }
}

beforeEach(() => {
  getRelayStateMock.mockReset().mockReturnValue('detached')
  reattachMock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('ensureRuntimeOwnedSshTargetAttached', () => {
  it('does not dial a target whose relay is already attached', async () => {
    getRelayStateMock.mockReturnValue('attached')
    await ensureRuntimeOwnedSshTargetAttached(sshRuntime('a', 'running'))
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('shares one in-flight connect between concurrent callers for the same target', async () => {
    let release!: () => void
    reattachMock.mockReturnValue(new Promise<void>((resolve) => (release = resolve)))
    const runtime = sshRuntime('b', 'running')
    const first = ensureRuntimeOwnedSshTargetAttached(runtime)
    const second = ensureRuntimeOwnedSshTargetAttached(runtime)
    expect(reattachMock).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    // Why: the entry must be cleared once settled, else a later failure could never retry.
    await ensureRuntimeOwnedSshTargetAttached(runtime)
    expect(reattachMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces the connect failure to the caller and allows a retry', async () => {
    reattachMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const runtime = sshRuntime('c', 'running')
    await expect(ensureRuntimeOwnedSshTargetAttached(runtime)).rejects.toThrow('ECONNREFUSED')
    await expect(ensureRuntimeOwnedSshTargetAttached(runtime)).resolves.toBeUndefined()
    expect(reattachMock).toHaveBeenCalledTimes(2)
  })
})

describe('reattachRuntimeOwnedSshTargetsAtStartup', () => {
  it('re-attaches every running SSH runtime and skips the rest', async () => {
    const userDataPath = makeUserData()
    upsertEphemeralVmRuntime(userDataPath, sshRuntime('running', 'running'))
    upsertEphemeralVmRuntime(userDataPath, sshRuntime('suspend-failed', 'suspend_failed'))
    upsertEphemeralVmRuntime(userDataPath, sshRuntime('suspended', 'suspended'))
    upsertEphemeralVmRuntime(userDataPath, sshRuntime('cleaned', 'cleaned'))
    upsertEphemeralVmRuntime(
      userDataPath,
      sshRuntime('orca-server', 'running', {
        connectionMode: 'orca-server',
        sshTargetId: undefined,
        runtimeEnvironmentId: 'env-1',
        recipeResult: { schemaVersion: 1, pairingCode: 'code', projectRoot: '/w' }
      })
    )

    await reattachRuntimeOwnedSshTargetsAtStartup(() => userDataPath)

    expect(reattachMock.mock.calls.map(([runtime]) => runtime.id).sort()).toEqual([
      'running',
      'suspend-failed'
    ])
  })

  it('keeps going when one runtime fails to re-attach', async () => {
    const userDataPath = makeUserData()
    upsertEphemeralVmRuntime(userDataPath, sshRuntime('fails', 'running'))
    upsertEphemeralVmRuntime(userDataPath, sshRuntime('works', 'running'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reattachMock.mockImplementation(async (runtime: EphemeralVmRuntimeRecord) => {
      if (runtime.id === 'fails') {
        throw new Error('host unreachable')
      }
    })

    await expect(
      reattachRuntimeOwnedSshTargetsAtStartup(() => userDataPath)
    ).resolves.toBeUndefined()

    expect(reattachMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fails'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('host unreachable'))
  })
})

describe('installRuntimeOwnedSshPtyProviderRecovery', () => {
  it('re-attaches a running runtime-owned target on a provider miss', async () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('miss', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    installRuntimeOwnedSshPtyProviderRecovery(() => userDataPath)

    await expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).resolves.toBeUndefined()

    expect(reattachMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'miss' }))
  })

  it('does nothing when the provider is already registered', () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('registered', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    installRuntimeOwnedSshPtyProviderRecovery(() => userDataPath)
    registerSshPtyProvider(runtime.sshTargetId, {} as never)
    try {
      expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).toBeUndefined()
      expect(reattachMock).not.toHaveBeenCalled()
    } finally {
      unregisterSshPtyProvider(runtime.sshTargetId)
    }
  })

  it.each([
    ['a user SSH target', 'ssh-1700000000-abc123'],
    ['a local spawn', null],
    ['an unknown runtime-owned id', 'runtime-ssh-not-persisted']
  ])('leaves the ordinary provider miss in place for %s', (_label, connectionId) => {
    const userDataPath = makeUserData()
    installRuntimeOwnedSshPtyProviderRecovery(() => userDataPath)
    expect(recoverMissingSshPtyProvider(connectionId)).toBeUndefined()
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('does not dial a runtime that is not expected to be up', () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('asleep', 'suspended')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    installRuntimeOwnedSshPtyProviderRecovery(() => userDataPath)
    expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).toBeUndefined()
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('leaves a relay that is reconnecting on its own alone', () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('self-healing', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    getRelayStateMock.mockReturnValue('reconnecting')
    installRuntimeOwnedSshPtyProviderRecovery(() => userDataPath)
    expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).toBeUndefined()
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('names the retry when the re-attach fails', async () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('refused', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    reattachMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2222'))
    installRuntimeOwnedSshPtyProviderRecovery(() => userDataPath)

    await expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).rejects.toThrow(
      /ECONNREFUSED 127\.0\.0\.1:2222.*Open the workspace again or start a new terminal/s
    )
  })
})
