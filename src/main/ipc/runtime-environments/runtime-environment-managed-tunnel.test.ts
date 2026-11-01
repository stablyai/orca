import type { RemoteRuntimeSubscriptionCallbacks } from '../../../shared/remote-runtime/remote-runtime-client'
import type * as RuntimeEnvironmentStore from '../../../shared/runtime-environment-store'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'
import { EventEmitter } from 'node:events'
import {
  registerRuntimeEnvironmentSubscriptionHandlers,
  type PendingRuntimeSubscription,
  type RetainedRemoteRuntimeSubscription
} from './runtime-environment-subscription-handlers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/protocol-version'
import { resetRuntimeEnvironmentCapabilityEvidence } from './runtime-environment-capability-evidence'
import {
  getRuntimeEnvironmentStatusOwner,
  resetRuntimeEnvironmentStatusOwners
} from './runtime-environment-request-connections'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { createEnvironmentFromPairingOffer } from '../../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import type * as ServingModule from '../../managed-server/lifecycle/orcad-managed-serving'
import type { ManagedOrcadStartListener } from '../../managed-server/lifecycle/orcad-managed-serving'
import type { SshTarget } from '../../../shared/ssh-types'
import type { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import type { updateManagedOrcadOnRestore } from '../../managed-server/lifecycle/orcad-managed-update-on-restore'

const mocks = vi.hoisted(() => {
  const startListener: { current: ManagedOrcadStartListener | null } = { current: null }
  const environments: Record<string, Record<string, unknown>> = {}
  const reads: Record<string, number> = {}
  return {
    environments,
    reads,
    ensureForRuntimeCall: vi.fn(async () => {}),
    requireRunningWithoutStart: vi.fn(async () => {}),
    hasWslService: true,
    rawSubscribe: vi.fn(),
    handle: vi.fn(),
    on: vi.fn(),
    ensureTunnel: vi.fn(async (..._args: Parameters<typeof ensureOrcadManagedTunnel>) => {}),
    rebuildTunnel: vi.fn(async () => {}),
    verify: vi.fn(),
    restoreUpdate: vi.fn((): ReturnType<typeof updateManagedOrcadOnRestore> => null),
    redeploy: vi.fn(async () => true),
    forgetVerdict: vi.fn(),
    restoreForwards: vi.fn(async () => {}),
    startListener
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: mocks.handle, on: mocks.on }
}))
vi.mock('../../../shared/remote-runtime/remote-runtime-client', () => ({
  subscribeRemoteRuntimeRequest: mocks.rawSubscribe
}))
vi.mock('./runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('./runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    getRemoteRuntimeSharedControlDiagnostics: vi.fn(() => ({ state: 'ready' })),
    sendRemoteRuntimeSharedControlRequest: vi.fn(),
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    reconnectRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn(),
    closeRemoteRuntimeRequestConnection: vi.fn()
  })
})
vi.mock('../../../shared/runtime-environment-store', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEnvironmentStore>()),
  resolveEnvironment: (_userData: string, id: string) => {
    const environment = mocks.environments[id]
    if (!environment) {
      return { id, orcadDeployment: { sshTargetId: 'ssh-1' } }
    }
    mocks.reads[id] = (mocks.reads[id] ?? 0) + 1
    // Fresh records distinguish the post-bring-up read from the initial lookup.
    return { ...environment, read: mocks.reads[id] }
  }
}))
vi.mock('../../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () =>
    mocks.hasWslService ? { ensureForRuntimeCall: mocks.ensureForRuntimeCall } : null,
  getWslHostPhoneGate: () =>
    mocks.hasWslService ? { requireRunningWithoutStart: mocks.requireRunningWithoutStart } : null
}))
vi.mock('../../ssh/managed-server-update-deps', () => ({ managedServerUpdateDeps: () => ({}) }))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  rebuildOrcadManagedTunnel: mocks.rebuildTunnel
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-serving-verify', () => ({
  verifyOrcadManagedServing: mocks.verify
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-update-on-restore', () => ({
  updateManagedOrcadOnRestore: mocks.restoreUpdate,
  redeployStoppedManagedOrcad: mocks.redeploy
}))
vi.mock('../../ssh/ssh-host-server-status', () => ({ setSshHostServerStatus: vi.fn() }))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => null }))
vi.mock('../ssh/ssh-ipc-context', () => ({
  connectionManager: null,
  getCurrentMainWindow: () => null
}))
vi.mock('../ssh/ssh-renderer-broadcast', () => ({ broadcastSshState: vi.fn() }))
vi.mock('../ssh/ssh-managed-port-forward-restore', () => ({
  restoreManagedHostPortForwards: mocks.restoreForwards
}))
vi.mock('../ssh/ssh-host-launch-session-note', () => ({
  forgetLaunchSessionVerdict: mocks.forgetVerdict
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-serving', async (importOriginal) => ({
  ...(await importOriginal<typeof ServingModule>()),
  setManagedOrcadStartListener: (listener: ManagedOrcadStartListener | null) => {
    mocks.startListener.current = listener
  }
}))

import { MANAGED_ORCAD_NOT_ACTIVATED_DETAIL } from '../../managed-server/lifecycle/orcad-managed-serving'
import {
  installManagedOrcadStartStatus,
  requireWslHostWithoutStart,
  resolveManagedRuntimeEnvironment
} from './runtime-environment-managed-tunnel'
import { WSL_HOSTS_GATED_OFF_MESSAGE } from '../../wsl/wsl-host-gate'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'

describe('resolving a managed runtime for a call', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redeploys, before the call, a server another desktop stopped mid-session', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).toHaveBeenCalledWith('env-1', expect.any(Function))
    expect(mocks.restoreUpdate).not.toHaveBeenCalled()
    expect(mocks.ensureTunnel).toHaveBeenCalledTimes(1)
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith('/u', 'env-1')
  })

  it('forgets a cached ended launch session once this client redeployed the server', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.forgetVerdict).toHaveBeenCalledWith('ssh-1')
    expect(mocks.forgetVerdict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rebuildTunnel.mock.invocationCallOrder[0]
    )
  })

  it('keeps the verdict when the redeploy did not start a server', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    mocks.redeploy.mockResolvedValueOnce(false)
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.forgetVerdict).not.toHaveBeenCalled()
  })

  // #32484: an update check that never settles, or a failed redeploy, publishes no served status.
  it.each([
    ['a serving server', { state: 'serving' }, true],
    [
      'a server whose redeploy failed',
      { state: 'unverifiable', detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL },
      false
    ]
  ] as const)(
    'restores saved forwards once the tunnel is up, for %s',
    async (_name, serving, redeployed) => {
      mocks.verify.mockResolvedValue(serving)
      mocks.redeploy.mockResolvedValueOnce(redeployed)
      await resolveManagedRuntimeEnvironment('/u', 'env-1')
      expect(mocks.restoreForwards).toHaveBeenCalledWith('ssh-1', { tunnelUp: true })
      expect(mocks.ensureTunnel.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.restoreForwards.mock.invocationCallOrder[0]
      )
    }
  )

  it('leaves a serving server to the once-per-session update check', async () => {
    mocks.verify.mockResolvedValue({ state: 'serving' })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).not.toHaveBeenCalled()
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('env-1', expect.any(Function))
  })
})

describe('resolving a runtime for a call, by host kind', () => {
  const wsl = {
    id: 'wsl:ubuntu',
    orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
  }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasWslService = true
    for (const id of Object.keys(mocks.reads)) {
      delete mocks.reads[id]
    }
    mocks.environments = { 'wsl:ubuntu': wsl, 'paired-1': { id: 'paired-1' } }
    mocks.verify.mockResolvedValue({ state: 'serving' })
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('brings a WSL host up through its service, never through an SSH tunnel', async () => {
    // Bring-up may change the WSL bridge port.
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).resolves.toEqual({
      ...wsl,
      read: 2
    })
    expect(mocks.ensureForRuntimeCall).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.restoreUpdate).not.toHaveBeenCalled()
  })

  it('resolves a WSL host with no service without bringing anything up', async () => {
    mocks.hasWslService = false
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).resolves.toEqual({
      ...wsl,
      read: 2
    })
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
  })

  it("serves a phone's call only from a WSL host already running, never starting it", async () => {
    const noStart = { wslStart: 'never' } as const
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu', noStart)).resolves.toEqual({
      ...wsl,
      read: 2
    })
    expect(mocks.requireRunningWithoutStart).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()

    mocks.requireRunningWithoutStart.mockRejectedValueOnce(new Error('stopped'))
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu', noStart)).rejects.toThrow(
      'stopped'
    )
    mocks.hasWslService = false
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu', noStart)).rejects.toThrow(
      'The WSL host Ubuntu isn’t available from your phone right now. On your computer, click Start if it’s stopped; otherwise open one of its projects to connect it.'
    )
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })

  it("checks only a WSL host for a phone's status probe, leaving any other server untouched", async () => {
    const noStart = { wslStart: 'never' } as const
    // An unknown id resolves to an SSH-managed server; paired-1 has no deployment.
    for (const id of ['ssh-managed', 'paired-1']) {
      await requireWslHostWithoutStart('/u', id, noStart)
    }
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
    expect(mocks.rebuildTunnel).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.requireRunningWithoutStart).not.toHaveBeenCalled()

    await requireWslHostWithoutStart('/u', 'wsl:ubuntu', noStart)
    expect(mocks.requireRunningWithoutStart).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })

  it('refuses a WSL host with the gate closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).rejects.toThrow(
      WSL_HOSTS_GATED_OFF_MESSAGE
    )
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })

  it('runs the managed tunnel path for a paired server too', async () => {
    await expect(resolveManagedRuntimeEnvironment('/u', 'paired-1')).resolves.toEqual({
      id: 'paired-1',
      read: 2
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/u', 'paired-1')
    expect(mocks.verify).toHaveBeenCalledWith('/u', 'paired-1')
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('paired-1', expect.any(Function))
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })
})

describe('a managed server start shown on the status line', () => {
  const target: SshTarget = { id: 'ssh-1', label: 'mac', host: 'mac', port: 22, username: 'u' }

  beforeEach(() => {
    vi.clearAllMocks()
    installManagedOrcadStartStatus()
  })

  it('forgets a cached ended launch session once this client started the server', async () => {
    mocks.startListener.current?.settled(target, 'env-1', { state: 'started', boundPort: 1 })
    await vi.waitFor(() => expect(mocks.forgetVerdict).toHaveBeenCalledWith('ssh-1'))
  })

  it('keeps the verdict when no start happened', async () => {
    mocks.startListener.current?.settled(target, 'env-1', { state: 'unverifiable', detail: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.forgetVerdict).not.toHaveBeenCalled()
  })
})

describe('crew retry at the actual IPC and routing boundary', () => {
  const remote = new Map<string, RetainedRemoteRuntimeSubscription>()
  const pending = new Map<string, PendingRuntimeSubscription>()
  const sender = Object.assign(new EventEmitter(), {
    id: 101,
    mainFrame: { detached: false },
    isDestroyed: () => false,
    send: vi.fn()
  })
  const environment = {
    ...createEnvironmentFromPairingOffer({
      id: 'crew',
      name: 'Builder',
      now: 1,
      connectionDependency: 'ssh-tunnel',
      offer: {
        v: PAIRING_OFFER_VERSION,
        endpoint: 'ws://127.0.0.1:42000',
        deviceToken: 'fixture',
        publicKeyB64: 'fixture'
      }
    }),
    runtimeId: 'runtime-1',
    orcadDeployment: {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 1,
      localPort: 42000,
      remotePort: 6768
    }
  }
  const args = {
    selector: 'crew',
    method: 'orchestration.crewSubscribe',
    subscriptionId: 'crew',
    setupResult: 'crew',
    expectedEnvironmentPairingRevision: 1,
    expectedEnvironmentRuntimeId: 'runtime-1'
  } as const
  function handler(channel: string) {
    return mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  }
  function open(
    overrides: Partial<Omit<typeof args, 'subscriptionId'>> & { subscriptionId?: string } = {}
  ) {
    return handler('runtimeEnvironments:subscribe')(
      { sender, senderFrame: sender.mainFrame },
      { ...args, ...overrides }
    )
  }
  function verify() {
    const owner = getRuntimeEnvironmentStatusOwner('/u', 'crew')
    owner.connectionChanged('ready')
    owner.acceptVerified({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-1',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    return owner
  }
  function noPreparation() {
    for (const effect of [
      mocks.ensureTunnel,
      mocks.rebuildTunnel,
      mocks.verify,
      mocks.restoreUpdate,
      mocks.redeploy,
      mocks.restoreForwards,
      mocks.ensureForRuntimeCall,
      mocks.requireRunningWithoutStart
    ]) {
      expect(effect).not.toHaveBeenCalled()
    }
  }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.environments = { crew: { ...environment } }
    mocks.ensureTunnel.mockReset().mockResolvedValue(undefined)
    mocks.rawSubscribe.mockReset().mockImplementation(async () => ({
      requestId: 'raw',
      close: vi.fn(),
      sendBinary: () => false
    }))
    mocks.verify.mockResolvedValue({ state: 'serving' })
    mocks.restoreUpdate.mockReset().mockReturnValue(null)
    resetRuntimeEnvironmentCapabilityEvidence()
    registerRuntimeEnvironmentSubscriptionHandlers({
      getUserDataPath: () => '/u',
      remoteRuntimeSubscriptions: remote,
      pendingSubscriptions: pending,
      recordLayoutFrame: vi.fn()
    })
  })
  afterEach(() => {
    for (const entry of pending.values()) {
      entry.close()
    }
    for (const entry of remote.values()) {
      entry.close()
    }
    pending.clear()
    remote.clear()
    resetRuntimeEnvironmentStatusOwners()
  })

  it('keeps ordinary first-mount preparation and original rejections, but retry dispatch acquires nothing', async () => {
    const original = new Error('ordinary preparation failed')
    mocks.ensureTunnel.mockRejectedValueOnce(original)
    await expect(
      handler('runtimeEnvironments:subscribe')(
        { sender },
        { selector: 'crew', method: args.method }
      )
    ).rejects.toBe(original)
    mocks.ensureTunnel.mockRejectedValueOnce(undefined)
    await expect(
      subscribeRuntimeEnvironment('/u', 'crew', args.method, {}, undefined, {
        onEvent: vi.fn(),
        onClose: vi.fn()
      })
    ).rejects.toBeUndefined()
    await expect(
      handler('runtimeEnvironments:subscribe')(
        { sender },
        { selector: 'crew', method: args.method }
      )
    ).resolves.toMatchObject({ requestId: 'raw' })
    expect(mocks.ensureTunnel).toHaveBeenCalledTimes(3)
    expect(mocks.verify).toHaveBeenCalledOnce()
    expect(mocks.restoreUpdate).toHaveBeenCalledOnce()
    expect(mocks.rawSubscribe).toHaveBeenCalledOnce()
    verify()
    for (const effect of [
      mocks.ensureTunnel,
      mocks.rebuildTunnel,
      mocks.verify,
      mocks.restoreUpdate,
      mocks.redeploy,
      mocks.restoreForwards,
      mocks.ensureForRuntimeCall,
      mocks.requireRunningWithoutStart,
      mocks.rawSubscribe
    ]) {
      effect.mockClear()
    }
    await expect(open()).resolves.toEqual({ subscriptionId: 'crew', ok: true })
    expect(mocks.rawSubscribe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:42000' }),
      args.method,
      undefined,
      15_000,
      expect.any(Object),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    noPreparation()
    expect(pending.size).toBe(0)
    expect(remote.has('crew')).toBe(true)
  })

  it('refuses a different raw runtime before recording or publishing its Crew response', async () => {
    verify()
    await open()
    const callbacks: RemoteRuntimeSubscriptionCallbacks = mocks.rawSubscribe.mock.lastCall![4]
    const replacement = {
      id: 'raw',
      ok: true as const,
      result: { type: 'begin', status: 'ready' },
      _meta: { runtimeId: 'replacement' }
    }
    expect(() => callbacks.onResponse(replacement)).toThrowError(
      expect.objectContaining({ code: 'runtime_environment_changed' })
    )
    expect(sender.send).not.toHaveBeenCalled()
    noPreparation()
  })

  it('does not prepare or dispatch for an unverified source', async () => {
    verify().connectionChanged('disconnected')
    await expect(open()).resolves.toMatchObject({ ok: false })
    expect(mocks.rawSubscribe).not.toHaveBeenCalled()
    noPreparation()
    expect(pending.size).toBe(0)
    expect(sender.eventNames()).toEqual([])
  })

  it('closes a handle settled after actual transport retirement without retaining or publishing it', async () => {
    verify()
    const held = Promise.withResolvers<Awaited<ReturnType<typeof subscribeRuntimeEnvironment>>>()
    mocks.rawSubscribe.mockReturnValueOnce(held.promise)
    const result = open()
    expect(pending.size).toBe(1)
    advanceRuntimeEnvironmentTransportGeneration('crew')
    const late = { requestId: 'retired', close: vi.fn(), sendBinary: () => false }
    held.resolve(late)
    await expect(result).resolves.toMatchObject({
      ok: false,
      failure: { fact: { kind: 'source-retired' } }
    })
    expect(late.close).toHaveBeenCalledOnce()
    expect(pending.size).toBe(0)
    expect(remote.size).toBe(0)
    expect(sender.send).not.toHaveBeenCalled()
    expect(sender.eventNames()).toEqual([])
    noPreparation()
  })
})
