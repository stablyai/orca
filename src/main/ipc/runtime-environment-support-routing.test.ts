import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  advanceRuntimeEnvironmentCapabilityIncarnation,
  applyRuntimeEnvironmentCapabilityVerdict,
  captureRuntimeEnvironmentCapabilityEvidence,
  resetRuntimeEnvironmentCapabilityEvidence,
  runtimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'

const { supportsMock, clearSupportMock, resolveEnvironmentMock } = vi.hoisted(() => ({
  supportsMock: vi.fn(),
  clearSupportMock: vi.fn(),
  resolveEnvironmentMock: vi.fn()
}))

vi.mock('./runtime-environment-shared-control-support', () => ({
  supportsSharedControl: supportsMock,
  clearSharedControlSupport: clearSupportMock
}))
vi.mock('../../shared/runtime-environment-store', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEnvironment: resolveEnvironmentMock
}))

import {
  routeRuntimeEnvironmentCallBySupport,
  routeRuntimeEnvironmentSubscriptionBySupport
} from './runtime-environment-support-routing'

beforeEach(() => {
  resetRuntimeEnvironmentCapabilityEvidence()
  supportsMock.mockReset()
  clearSupportMock.mockReset()
  resolveEnvironmentMock.mockReset()
  resolveEnvironmentMock.mockReturnValue(environment())
})

describe('runtime environment support routing', () => {
  it('re-probes an unpinned stale call exactly once and succeeds', async () => {
    supportsMock
      .mockResolvedValueOnce({ kind: 'stale_incarnation' })
      .mockResolvedValueOnce(acceptedOutcome('capable'))
    const supported = vi.fn().mockResolvedValue(success())
    const unsupported = vi.fn()

    await expect(
      routeRuntimeEnvironmentCallBySupport({
        userDataPath: '/profile',
        initialEnvironment: environment(),
        method: 'repo.list',
        timeoutMs: 100,
        supported,
        unsupported,
        markUsed: vi.fn()
      })
    ).resolves.toMatchObject({ ok: true })

    expect(supportsMock).toHaveBeenCalledTimes(2)
    expect(clearSupportMock).toHaveBeenCalledOnce()
    expect(supported).toHaveBeenCalledOnce()
    expect(unsupported).not.toHaveBeenCalled()
  })

  it('fails a pinned stale call before probing or creating against the replacement', async () => {
    supportsMock.mockResolvedValueOnce({ kind: 'stale_incarnation' })
    resolveEnvironmentMock.mockReturnValue(environment({ pairingRevision: 2 }))
    const supported = vi.fn()
    const unsupported = vi.fn()

    const result = await routeRuntimeEnvironmentCallBySupport({
      userDataPath: '/profile',
      initialEnvironment: environment({ pairingRevision: 1 }),
      expectedPairingRevision: 1,
      method: 'repo.list',
      timeoutMs: 100,
      supported,
      unsupported,
      markUsed: vi.fn()
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    expect(supportsMock).toHaveBeenCalledOnce()
    expect(supported).not.toHaveBeenCalled()
    expect(unsupported).not.toHaveBeenCalled()
  })

  it('delivers a response but suppresses identity writes after response-time invalidation', async () => {
    supportsMock.mockResolvedValue(acceptedOutcome('absent'))
    const pending = deferred<ReturnType<typeof success>>()
    const unsupported = vi.fn().mockReturnValue(pending.promise)
    const markUsed = vi.fn()
    const routed = routeRuntimeEnvironmentCallBySupport({
      userDataPath: '/profile',
      initialEnvironment: environment(),
      method: 'repo.list',
      timeoutMs: 100,
      supported: vi.fn(),
      unsupported,
      markUsed
    })
    await vi.waitFor(() => expect(unsupported).toHaveBeenCalledOnce())
    advanceRuntimeEnvironmentCapabilityIncarnation('env')
    pending.resolve(success())

    await expect(routed).resolves.toMatchObject({ ok: true })
    expect(markUsed).not.toHaveBeenCalled()
  })

  it('fails a stale subscription before either factory is touched', async () => {
    const outcome = acceptedOutcome('capable')
    supportsMock.mockImplementation(async () => {
      advanceRuntimeEnvironmentCapabilityIncarnation('env')
      return outcome
    })
    const supported = vi.fn()
    const unsupported = vi.fn()

    await expect(
      routeRuntimeEnvironmentSubscriptionBySupport({
        userDataPath: '/profile',
        environment: environment(),
        timeoutMs: 100,
        isCurrent: () => true,
        supported,
        unsupported
      })
    ).rejects.toThrow('Runtime environment pairing changed')
    expect(supported).not.toHaveBeenCalled()
    expect(unsupported).not.toHaveBeenCalled()
  })
})

function acceptedOutcome(verdict: 'capable' | 'absent') {
  const environmentId = 'env'
  const pairing = {
    v: 2 as const,
    endpoint: 'ws://host',
    deviceToken: 'token',
    publicKeyB64: 'key'
  }
  const evidence = captureRuntimeEnvironmentCapabilityEvidence(environmentId, pairing)
  applyRuntimeEnvironmentCapabilityVerdict({ evidence, verdict, runtimeId: 'runtime' })
  return runtimeEnvironmentCapabilityOutcome(evidence, verdict, 'runtime')
}

function environment(overrides: Partial<KnownRuntimeEnvironment> = {}): KnownRuntimeEnvironment {
  return {
    id: 'env',
    name: 'Environment',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: 'runtime',
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://host',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ],
    preferredEndpointId: 'ws',
    ...overrides
  }
}

function success() {
  return { id: 'repo.list', ok: true as const, result: {}, _meta: { runtimeId: 'runtime' } }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
