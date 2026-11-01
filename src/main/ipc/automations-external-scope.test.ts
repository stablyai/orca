import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isExternalAutomationProbeCancelled } from '../automations/external-automation-probe-scheduler'
import { EXTERNAL_AUTOMATION_SCOPE_CODES } from '../../shared/external-automation-scope'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../shared/automation-owner-conflict'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type { SshTarget } from '../../shared/ssh-types'
import type { AutomationService } from '../automations/service'
import type { Store } from '../persistence'
import type * as Fs from 'node:fs'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import { ExternalAutomationManagerCache } from '../automations/external-automation-manager-cache'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const ipcHandlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

// Each scoped probe performs one local which lookup.
const probeCommand = vi.hoisted(() => vi.fn())
const fileExists = vi.hoisted(() => vi.fn(() => false))
const readRegistrations = vi.fn(() => state.targets)
vi.mock('@orca/process-host', () => ({ runProcess: probeCommand }))
// Isolate external job reads from the developer's real home.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof Fs>()),
  existsSync: fileExists
}))
const PROBE_FOUND = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

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

const desktopSelf: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
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
  probeCommand.mockReset()
  probeCommand.mockResolvedValue(PROBE_FOUND)
  fileExists.mockClear()
  readRegistrations.mockClear()
  state.targets = [sshTarget()]
  state.service = { externalProbePriority: null }
  const { registerAutomationHandlers } = await import('./automations')
  const store = {
    getSshTargets: readRegistrations,
    assertAutomationOwnerFence: () => undefined
  }
  registerAutomationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handler registration reads only these store methods.
    store as unknown as Store,
    state.service as unknown as AutomationService
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('scoped external-manager IPC', () => {
  it.each(['hermes', 'unknown', 'toString'])(
    'rejects %s before cache, filesystem, process, or host work',
    async (provider) => {
      const cacheRead = vi.spyOn(ExternalAutomationManagerCache.prototype, 'resolve')
      const cacheWrite = vi.spyOn(ExternalAutomationManagerCache.prototype, 'invalidateOwner')
      try {
        for (const owner of [desktopSelf, desktopSsh()]) {
          await expect(
            invoke('automations:listExternalManagerForOwner', { owner, provider })
          ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.providerNotAllowed)
          await expect(
            invoke('automations:runExternalActionForOwner', {
              owner,
              provider,
              jobId: 'job-1',
              action: 'delete'
            })
          ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.providerNotAllowed)
        }
        expect(cacheRead).not.toHaveBeenCalled()
        expect(cacheWrite).not.toHaveBeenCalled()
        expect(fileExists).not.toHaveBeenCalled()
        expect(probeCommand).not.toHaveBeenCalled()
        expect(readRegistrations).not.toHaveBeenCalled()
      } finally {
        cacheRead.mockRestore()
        cacheWrite.mockRestore()
      }
    }
  )

  it('does not register external create, edit, or history handlers', () => {
    for (const channel of [
      'automations:createExternalForOwner',
      'automations:updateExternalForOwner',
      'automations:listExternalRunsForOwner'
    ]) {
      expect(ipcHandlers.has(channel)).toBe(false)
    }
  })

  it('derives the target from the captured owner rather than the payload', async () => {
    const entry = await invoke('automations:listExternalManagerForOwner', {
      owner: desktopSsh(),
      provider: 'openclaw',
      target: { type: 'local' }
    })

    // An SSH owner cannot be rerouted locally by a payload target.
    expect(entry).toMatchObject({ manager: null, error: SSH_HOST_NOT_SERVED_MESSAGE })
    expect(probeCommand).not.toHaveBeenCalled()
  })

  it('refuses a request with no captured owner without probing', async () => {
    await expect(
      invoke('automations:listExternalManagerForOwner', { provider: 'openclaw' })
    ).rejects.toThrow(/automation owner is required/i)
    await expect(invoke('automations:runExternalActionForOwner', {})).rejects.toThrow(
      /automation owner is required/i
    )
    expect(probeCommand).not.toHaveBeenCalled()
  })

  it('refuses a runtime authority, so runtime hosts are never tunnelled', async () => {
    await expect(
      invoke('automations:listExternalManagerForOwner', {
        owner: {
          authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 2 },
          selector: { kind: 'self' }
        },
        provider: 'openclaw'
      })
    ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
    expect(probeCommand).not.toHaveBeenCalled()
  })

  it('refuses a runtime-owned SSH target as hidden rather than as a probe failure', async () => {
    state.targets = [sshTarget({ owner: { type: 'on-demand-runtime', runtimeId: 'env-1' } })]
    await expect(
      invoke('automations:listExternalManagerForOwner', {
        owner: desktopSsh(),
        provider: 'openclaw'
      })
    ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden)
    expect(probeCommand).not.toHaveBeenCalled()
  })

  it('refuses a stale host incarnation with the shared conflict vocabulary', async () => {
    state.targets = [sshTarget({ generation: 4 })]
    await expect(
      invoke('automations:listExternalManagerForOwner', {
        owner: desktopSsh('t1', 3),
        provider: 'openclaw'
      })
    ).rejects.toThrow(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
    expect(probeCommand).not.toHaveBeenCalled()
  })

  it('keeps one cache across requests, so a repeat read costs no second probe', async () => {
    const request = { owner: desktopSelf, provider: 'openclaw' }
    await invoke('automations:listExternalManagerForOwner', request)
    await invoke('automations:listExternalManagerForOwner', request)
    expect(probeCommand).toHaveBeenCalledTimes(1)

    await invoke('automations:listExternalManagerForOwner', { ...request, refresh: true })
    expect(probeCommand).toHaveBeenCalledTimes(2)
  })

  it('invalidates that host after a mutation through the scoped path', async () => {
    const request = { owner: desktopSelf, provider: 'openclaw' }
    await invoke('automations:listExternalManagerForOwner', request)
    await invoke('automations:runExternalActionForOwner', {
      ...request,
      jobId: 'job-1',
      action: 'run'
    })
    await invoke('automations:listExternalManagerForOwner', request)

    // action + the re-probe after invalidation, on top of the first list.
    expect(probeCommand).toHaveBeenCalledTimes(3)
  })
})

describe('probe scope retention', () => {
  it('cancels an in-flight probe once its host leaves the retained set', async () => {
    const probe: { release: () => void } = { release: () => undefined }
    probeCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          probe.release = () => resolve(PROBE_FOUND)
        })
    )
    const pending = invoke('automations:listExternalManagerForOwner', {
      owner: desktopSelf,
      provider: 'openclaw'
    })
    const settled = pending.catch((error: unknown) => error)
    await Promise.resolve()

    await invoke('automations:retainExternalScopes', { owners: [] })

    const error = await settled
    expect(isExternalAutomationProbeCancelled(error)).toBe(true)
    probe.release()
  })
})

describe('Orca automation traffic priority', () => {
  it('parks queued probes while Orca automation work holds the installed lease', async () => {
    // Runtime CRUD/dispatch takes the lease installed on the service by registration.
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
      owner: desktopSelf,
      provider: 'openclaw'
    })
    await Promise.resolve()
    // Queued probes must not compete with pending user-facing work.
    expect(probeCommand).not.toHaveBeenCalled()

    finish()
    await dispatch
    await probe
    expect(probeCommand).toHaveBeenCalledTimes(1)
  })
})
