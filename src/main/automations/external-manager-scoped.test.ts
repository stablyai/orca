import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScopedExternalAutomations } from './external-manager'
import { ExternalAutomationManagerCache } from './external-automation-manager-cache'
import { ExternalAutomationProbeScheduler } from './external-automation-probe-scheduler'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { AutomationOwnerConflictError } from '../../shared/automation-owner-conflict'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  ExternalAutomationScopeError
} from '../../shared/external-automation-scope'
import type { ExternalAutomationProvider } from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import type * as Fs from 'node:fs'

const runProcessMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return { ...actual, existsSync: existsSyncMock }
})
vi.mock('../ssh/ssh-target-registry', () => ({ getActiveMultiplexer: vi.fn() }))

function sshTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'target-a',
    label: 'Build box',
    host: 'build.example',
    port: 22,
    username: 'orca',
    generation: 3,
    ...overrides
  }
}

const desktopSelf: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}

function desktopSsh(targetId: string, targetGeneration: number): AutomationOwnerRef {
  return { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId, targetGeneration } }
}

/** Stands in for the Orca automation store: readable, but never markable unavailable from here. */
function orcaStoreHealth() {
  return { read: vi.fn<() => void>(), markUnavailable: vi.fn<() => void>() }
}

function buildEngine(targets: SshTarget[]) {
  return createScopedExternalAutomations({
    registry: { getSshTargets: () => targets },
    scheduler: new ExternalAutomationProbeScheduler(),
    cache: new ExternalAutomationManagerCache({ ttlMs: 0 })
  })
}

function relay(response: unknown): {
  isDisposed: () => boolean
  request: ReturnType<typeof vi.fn>
} {
  return { isDisposed: () => false, request: vi.fn().mockResolvedValue(response) }
}

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessMock.mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  existsSyncMock.mockReturnValue(false)
  vi.mocked(getActiveMultiplexer).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('scoped external automations', () => {
  // The probe's own timeout, not the caller's: a provider binary that never
  // returns must still resolve the entry, or the page waits forever on one host.
  it('settles when a local command lookup hangs', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValue({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })
    const promise = buildEngine([]).listManager({ owner: desktopSelf, provider: 'hermes' })
    let settled = false
    void promise.finally(() => {
      settled = true
    })

    await expect(promise).resolves.toMatchObject({ manager: null })
    expect(settled).toBe(true)
  })

  it('probes only local managers when Local is selected', async () => {
    const engine = buildEngine([sshTarget(), sshTarget({ id: 'target-b', generation: 1 })])

    const entry = await engine.listManager({ owner: desktopSelf, provider: 'hermes' })

    expect(entry.manager?.id).toBe('hermes:local')
    expect(getActiveMultiplexer).not.toHaveBeenCalled()
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock.mock.calls[0]?.[0]).toEqual({
      program: 'which',
      args: ['hermes'],
      timeoutMs: 5_000
    })
  })

  it('does not reach out to any SSH target from a Local view', async () => {
    const engine = buildEngine([sshTarget(), sshTarget({ id: 'target-b', generation: 1 })])

    await engine.listManager({ owner: desktopSelf, provider: 'hermes' })
    await engine.listManager({ owner: desktopSelf, provider: 'openclaw' })

    expect(getActiveMultiplexer).not.toHaveBeenCalled()
  })

  it('probes only the selected SSH host', async () => {
    vi.mocked(getActiveMultiplexer).mockReturnValue(
      relay({ jobs: [], hermesAvailable: true }) as unknown as ReturnType<
        typeof getActiveMultiplexer
      >
    )
    const engine = buildEngine([sshTarget(), sshTarget({ id: 'target-b', generation: 1 })])

    const entry = await engine.listManager({
      owner: desktopSsh('target-a', 3),
      provider: 'hermes'
    })

    expect(entry.manager?.id).toBe('hermes:ssh:target-a')
    expect(getActiveMultiplexer).toHaveBeenCalledTimes(1)
    expect(getActiveMultiplexer).toHaveBeenCalledWith('target-a')
  })

  it('fails closed on a stale generation without probing', async () => {
    const engine = buildEngine([sshTarget({ generation: 4 })])

    await expect(
      engine.listManager({ owner: desktopSsh('target-a', 3), provider: 'hermes' })
    ).rejects.toBeInstanceOf(AutomationOwnerConflictError)
    expect(getActiveMultiplexer).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('excludes a runtime-owned target without probing it', async () => {
    const engine = buildEngine([
      sshTarget({ owner: { type: 'on-demand-runtime', runtimeId: 'rt-1' } })
    ])

    await expect(
      engine.listManager({ owner: desktopSsh('target-a', 3), provider: 'hermes' })
    ).rejects.toBeInstanceOf(ExternalAutomationScopeError)
    expect(getActiveMultiplexer).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects a runtime authority before any probe', async () => {
    const engine = buildEngine([])

    await expect(
      engine.listManager({
        owner: {
          authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 2 },
          selector: { kind: 'self' }
        },
        provider: 'hermes'
      })
    ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(getActiveMultiplexer).not.toHaveBeenCalled()
  })

  it('rejects an unknown provider before launching any command', async () => {
    const engine = buildEngine([sshTarget()])
    const unknown = 'cron' as ExternalAutomationProvider

    await expect(
      engine.runAction({
        owner: desktopSelf,
        provider: unknown,
        jobId: 'job-1',
        action: 'delete'
      })
    ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.providerNotAllowed)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(getActiveMultiplexer).not.toHaveBeenCalled()
  })

  it('fails a scoped mutation closed when the host changed under the dialog', async () => {
    const engine = buildEngine([sshTarget({ generation: 5 })])

    await expect(
      engine.update({
        owner: desktopSsh('target-a', 3),
        provider: 'hermes',
        jobId: 'job-1',
        name: 'Nightly',
        prompt: 'do the thing',
        schedule: '0 2 * * *',
        workdir: null
      })
    ).rejects.toBeInstanceOf(AutomationOwnerConflictError)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(getActiveMultiplexer).not.toHaveBeenCalled()
  })

  it('confines a manager failure to its own scope and never to Orca store health', async () => {
    const health = orcaStoreHealth()
    vi.mocked(getActiveMultiplexer).mockReturnValue(
      undefined as unknown as ReturnType<typeof getActiveMultiplexer>
    )
    const engine = createScopedExternalAutomations({
      registry: {
        getSshTargets: () => {
          health.read()
          return [sshTarget()]
        }
      },
      scheduler: new ExternalAutomationProbeScheduler(),
      cache: new ExternalAutomationManagerCache({ ttlMs: 0 })
    })

    const failed = await engine.listManager({
      owner: desktopSsh('target-a', 3),
      provider: 'hermes'
    })
    const healthy = await engine.listManager({ owner: desktopSelf, provider: 'hermes' })

    expect(failed.manager?.status).toBe('unavailable')
    expect(failed.manager?.error).toBe('SSH target is not connected.')
    expect(healthy.manager?.status).toBe('available')
    expect(health.markUnavailable).not.toHaveBeenCalled()
  })

  it('routes scoped runs through the selected host without accepting a target from the caller', async () => {
    const requestMock = vi.fn().mockResolvedValue({ total: 2, runs: [] })
    vi.mocked(getActiveMultiplexer).mockReturnValue({
      isDisposed: () => false,
      request: requestMock
    } as unknown as ReturnType<typeof getActiveMultiplexer>)
    const engine = buildEngine([sshTarget()])

    const page = await engine.listRuns({
      owner: desktopSsh('target-a', 3),
      provider: 'hermes',
      jobId: 'job-1',
      page: 1,
      pageSize: 10
    })

    expect(page.target).toEqual({ type: 'ssh', connectionId: 'target-a' })
    expect(page.managerId).toBe('hermes:ssh:target-a')
    expect(page.total).toBe(2)
  })
})
