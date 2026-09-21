import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isExternalAutomationProbeCancelled } from '../automations/external-automation-probe-scheduler'
import { EXTERNAL_AUTOMATION_SCOPE_CODES } from '../../shared/external-automation-scope'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../shared/automation-owner-conflict'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type { SshTarget } from '../../shared/ssh-types'
import type { AutomationService } from '../automations/service'
import type { Store } from '../persistence'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const ipcHandlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

// The relay is the only seam a scoped SSH probe crosses, so it stands in for the host.
const relay = {
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  isDisposed: () => false
}
vi.mock('../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: () => relay
}))

function sshTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 't1',
    label: 'build-box',
    host: 'build.example',
    user: 'orca',
    generation: 3,
    ...overrides
  } as SshTarget
}

function desktopSsh(targetId = 't1', targetGeneration = 3): AutomationOwnerRef {
  return {
    authority: { kind: 'desktop' },
    selector: { kind: 'ssh', targetId, targetGeneration }
  }
}

const state: {
  targets: SshTarget[]
  /** The lease registration installs on the service, for the runtime methods to take. */
  service: { externalProbePriority: (<T>(run: () => T) => T) | null }
} = {
  targets: [sshTarget()],
  service: { externalProbePriority: null }
}

/** Async like the real bridge: Electron turns a handler's sync throw into a rejection. */
async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = ipcHandlers.get(channel)
  if (!handler) {
    throw new Error(`no handler registered for ${channel}`)
  }
  return await handler(null, payload)
}

beforeEach(async () => {
  ipcHandlers.clear()
  relay.request.mockReset()
  relay.request.mockResolvedValue({ jobs: [], hermesAvailable: true, error: null })
  state.targets = [sshTarget()]
  state.service = { externalProbePriority: null }
  const { registerAutomationHandlers } = await import('./automations')
  registerAutomationHandlers(
    {
      getSshTargets: () => state.targets,
      assertAutomationOwnerFence: () => undefined
    } as unknown as Store,
    state.service as unknown as AutomationService
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('scoped external-manager IPC', () => {
  it('derives the target from the captured owner rather than the payload', async () => {
    const entry = (await invoke('automations:listExternalManagerForOwner', {
      owner: desktopSsh(),
      provider: 'hermes'
    })) as { manager: { id: string; target: unknown } | null; error: string | null }

    expect(relay.request).toHaveBeenCalledWith('externalAutomations.list', { provider: 'hermes' })
    expect(entry.manager?.id).toBe('hermes:ssh:t1')
    expect(entry.manager?.target).toEqual({ type: 'ssh', connectionId: 't1' })
    expect(entry.error).toBeNull()
  })

  it('refuses a request with no captured owner without probing', async () => {
    await expect(
      invoke('automations:listExternalManagerForOwner', { provider: 'hermes' })
    ).rejects.toThrow(/automation owner is required/i)
    await expect(invoke('automations:runExternalActionForOwner', {})).rejects.toThrow(
      /automation owner is required/i
    )
    expect(relay.request).not.toHaveBeenCalled()
  })

  it('refuses a runtime authority, so runtime hosts are never tunnelled', async () => {
    await expect(
      invoke('automations:listExternalManagerForOwner', {
        owner: {
          authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 2 },
          selector: { kind: 'self' }
        },
        provider: 'hermes'
      })
    ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
    expect(relay.request).not.toHaveBeenCalled()
  })

  it('refuses a runtime-owned SSH target as hidden rather than as a probe failure', async () => {
    state.targets = [sshTarget({ owner: { type: 'on-demand-runtime', runtimeId: 'env-1' } })]
    await expect(
      invoke('automations:listExternalManagerForOwner', { owner: desktopSsh(), provider: 'hermes' })
    ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden)
    expect(relay.request).not.toHaveBeenCalled()
  })

  it('refuses a stale host incarnation with the shared conflict vocabulary', async () => {
    state.targets = [sshTarget({ generation: 4 })]
    await expect(
      invoke('automations:listExternalManagerForOwner', {
        owner: desktopSsh('t1', 3),
        provider: 'hermes'
      })
    ).rejects.toThrow(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
    expect(relay.request).not.toHaveBeenCalled()
  })

  it('keeps one cache across requests, so a repeat read costs no second probe', async () => {
    const request = { owner: desktopSsh(), provider: 'hermes' }
    await invoke('automations:listExternalManagerForOwner', request)
    await invoke('automations:listExternalManagerForOwner', request)
    expect(relay.request).toHaveBeenCalledTimes(1)

    await invoke('automations:listExternalManagerForOwner', { ...request, refresh: true })
    expect(relay.request).toHaveBeenCalledTimes(2)
  })

  it('invalidates that host after a mutation through the scoped path', async () => {
    const request = { owner: desktopSsh(), provider: 'hermes' }
    await invoke('automations:listExternalManagerForOwner', request)
    await invoke('automations:createExternalForOwner', {
      ...request,
      name: 'Nightly',
      prompt: 'sweep',
      schedule: '0 9 * * *',
      workdir: null
    })
    await invoke('automations:listExternalManagerForOwner', request)

    // create + the re-probe after invalidation, on top of the first list.
    expect(relay.request).toHaveBeenCalledTimes(3)
  })
})

describe('probe scope retention', () => {
  it('cancels an in-flight probe once its host leaves the retained set', async () => {
    const probe: { release: () => void } = { release: () => undefined }
    relay.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          probe.release = () => resolve({ jobs: [], hermesAvailable: true, error: null })
        })
    )
    const pending = invoke('automations:listExternalManagerForOwner', {
      owner: desktopSsh(),
      provider: 'hermes'
    }) as Promise<unknown>
    const settled = pending.catch((error: unknown) => error)
    await Promise.resolve()

    await invoke('automations:retainExternalScopes', { owners: [] })

    const error = await settled
    expect(isExternalAutomationProbeCancelled(error)).toBe(true)
    probe.release()
  })

  it('keeps probing a host that is still retained', async () => {
    await invoke('automations:retainExternalScopes', { owners: [desktopSsh()] })
    const entry = (await invoke('automations:listExternalManagerForOwner', {
      owner: desktopSsh(),
      provider: 'hermes'
    })) as { manager: unknown }
    expect(entry.manager).not.toBeNull()
  })
})

describe('Orca automation traffic priority', () => {
  it('parks queued probes while Orca automation work holds the installed lease', async () => {
    // Orca CRUD and dispatch arrive through the runtime methods, which take the
    // lease through the hook this registration installed on the service.
    const lease = state.service.externalProbePriority
    expect(lease).not.toBeNull()
    let finish: () => void = () => undefined
    const dispatch = lease!(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )

    const probe = invoke('automations:listExternalManagerForOwner', {
      owner: desktopSsh(),
      provider: 'hermes'
    }) as Promise<unknown>
    await Promise.resolve()
    // Why: the probe is queued, not started — this is the only thing keeping
    // external discovery from competing with the work the user is waiting on.
    expect(relay.request).not.toHaveBeenCalled()

    finish()
    await dispatch
    await probe
    expect(relay.request).toHaveBeenCalledTimes(1)
  })
})
