import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import type {
  EphemeralVmRuntimeRecord,
  EphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtimes'

const { getRelayStateMock, reattachMock, needsCredentialPromptMock } = vi.hoisted(() => ({
  getRelayStateMock: vi.fn(),
  reattachMock: vi.fn(),
  needsCredentialPromptMock: vi.fn()
}))

vi.mock('./ephemeral-vm-runtime-ssh', () => ({
  getRuntimeOwnedSshRelayState: getRelayStateMock,
  reattachRuntimeOwnedSshTarget: reattachMock,
  runtimeOwnedSshTargetNeedsCredentialPrompt: needsCredentialPromptMock
}))

import {
  RUNTIME_SSH_REATTACH_TIMEOUT_MS,
  RUNTIME_SSH_STARTUP_REATTACH_CONCURRENCY,
  ensureRuntimeOwnedSshTargetAttached,
  installRuntimeOwnedSshProviderMissRecovery,
  reattachRuntimeOwnedSshTargetsAtStartup
} from './ephemeral-vm-runtime-ssh-reattach'
import { recoverMissingSshPtyProvider } from './ipc/pty/provider/missing-ssh-pty-provider-recovery'
import { registerSshPtyProvider, unregisterSshPtyProvider } from './ipc/pty/provider/registry'
import {
  recoverSshProviderMiss,
  setSshProviderMissRecovery
} from './providers/ssh-provider-miss-recovery'

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
  needsCredentialPromptMock.mockReset().mockReturnValue(false)
})

afterEach(() => {
  setSshProviderMissRecovery(null)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
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

  it('bounds the shared wait so a dial that never settles cannot hold every joiner', async () => {
    // Why: a passphrase prompt with no listener, or a host that black-holes SYNs, would
    // otherwise pin every spawn and activation that joined this promise indefinitely.
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    reattachMock.mockImplementation(
      (_runtime: unknown, signal?: AbortSignal) =>
        new Promise<void>(() => {
          observedSignal = signal
        })
    )
    const runtime = sshRuntime('hang', 'running')
    const spawnJoiner = ensureRuntimeOwnedSshTargetAttached(runtime)
    const activationJoiner = ensureRuntimeOwnedSshTargetAttached(runtime)
    const rejections = Promise.all([
      expect(spawnJoiner).rejects.toThrow(/did not attach within 15s/),
      expect(activationJoiner).rejects.toThrow(/did not attach within 15s/)
    ])
    await vi.advanceTimersByTimeAsync(RUNTIME_SSH_REATTACH_TIMEOUT_MS - 1)
    expect(observedSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejections
    expect(observedSignal?.aborted).toBe(true)
    // Why: the entry is cleared on timeout so the next gesture re-checks state and redials.
    reattachMock.mockResolvedValue(undefined)
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

  it('defers a target whose last connect needed a credential prompt', async () => {
    // Why: the renderer's startup restore partitions on the persisted flag for the same
    // reason — no one is listening for the prompt yet, and dialing would only burn the
    // credential timeout. The first user gesture re-attaches it instead.
    const userDataPath = makeUserData()
    upsertEphemeralVmRuntime(userDataPath, sshRuntime('keyless', 'running'))
    upsertEphemeralVmRuntime(userDataPath, sshRuntime('passphrase', 'running'))
    needsCredentialPromptMock.mockImplementation(
      (targetId: string) => targetId === 'runtime-ssh-passphrase'
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await reattachRuntimeOwnedSshTargetsAtStartup(() => userDataPath)

    expect(reattachMock.mock.calls.map(([runtime]) => runtime.id)).toEqual(['keyless'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deferring'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('passphrase'))
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

  it('bounds how many relays it dials at once', async () => {
    // Why: every record a crash left `running` is dialed here; an unbounded fan-out opens
    // one SSH transport per record simultaneously.
    const userDataPath = makeUserData()
    const total = RUNTIME_SSH_STARTUP_REATTACH_CONCURRENCY * 3
    for (let i = 0; i < total; i += 1) {
      upsertEphemeralVmRuntime(userDataPath, sshRuntime(`rt-${i}`, 'running'))
    }
    let inFlight = 0
    let peak = 0
    const releases: (() => void)[] = []
    reattachMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          releases.push(() => {
            inFlight -= 1
            resolve()
          })
        })
    )

    const pass = reattachRuntimeOwnedSshTargetsAtStartup(() => userDataPath)
    await vi.waitFor(() =>
      expect(reattachMock).toHaveBeenCalledTimes(RUNTIME_SSH_STARTUP_REATTACH_CONCURRENCY)
    )
    // Why drain this way: each release lets a worker start the next dial only after several
    // microtask hops; wait for that dial to register before releasing again.
    let released = 0
    while (released < total) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0))
      releases.shift()!()
      released += 1
    }
    await pass

    expect(reattachMock).toHaveBeenCalledTimes(total)
    expect(peak).toBe(RUNTIME_SSH_STARTUP_REATTACH_CONCURRENCY)
  })
})

describe('installRuntimeOwnedSshProviderMissRecovery', () => {
  it('re-attaches a running runtime-owned target on a PTY provider miss', async () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('miss', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    installRuntimeOwnedSshProviderMissRecovery(() => userDataPath)

    await expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).resolves.toBeUndefined()

    expect(reattachMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'miss' }),
      expect.any(AbortSignal)
    )
  })

  it('serves the git and filesystem miss sites through the same recovery', async () => {
    // Why: the reporter's second string ("Remote connection dropped…") comes from those
    // dispatchers; a PTY-only hook would leave the sidebar, file tree, and source control
    // failing after a restart while terminals recovered.
    const userDataPath = makeUserData()
    const runtime = sshRuntime('git-miss', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    installRuntimeOwnedSshProviderMissRecovery(() => userDataPath)

    await expect(recoverSshProviderMiss(runtime.sshTargetId)).resolves.toBeUndefined()

    expect(reattachMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'git-miss' }),
      expect.any(AbortSignal)
    )
  })

  it('does nothing when the provider is already registered', () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('registered', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    installRuntimeOwnedSshProviderMissRecovery(() => userDataPath)
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
    installRuntimeOwnedSshProviderMissRecovery(() => userDataPath)
    expect(recoverMissingSshPtyProvider(connectionId)).toBeUndefined()
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('does not dial a runtime that is not expected to be up', () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('asleep', 'suspended')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    installRuntimeOwnedSshProviderMissRecovery(() => userDataPath)
    expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).toBeUndefined()
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('leaves a relay that is reconnecting on its own alone', () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('self-healing', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    getRelayStateMock.mockReturnValue('reconnecting')
    installRuntimeOwnedSshProviderMissRecovery(() => userDataPath)
    expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).toBeUndefined()
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('names the retry, as a separate sentence, when the re-attach fails', async () => {
    const userDataPath = makeUserData()
    const runtime = sshRuntime('refused', 'running')
    upsertEphemeralVmRuntime(userDataPath, runtime)
    reattachMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2222'))
    installRuntimeOwnedSshProviderMissRecovery(() => userDataPath)

    // Why the full string: `orca terminal create` shows it verbatim; the renderer re-renders
    // it, so its shape is also the contract the renderer parser is pinned against.
    await expect(recoverMissingSshPtyProvider(runtime.sshTargetId)).rejects.toThrow(
      'No PTY provider for connection "runtime-ssh-refused": the SSH relay for this workspace ' +
        'could not be re-attached: connect ECONNREFUSED 127.0.0.1:2222. ' +
        'Open the workspace again or start a new terminal to retry.'
    )
  })
})
