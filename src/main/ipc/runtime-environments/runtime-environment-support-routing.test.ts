import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RangedFileDocuments } from '../filesystem/ranged-file-documents'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  advanceRuntimeEnvironmentCapabilityIncarnation,
  applyRuntimeEnvironmentCapabilityVerdict,
  captureRuntimeEnvironmentCapabilityEvidence,
  resetRuntimeEnvironmentCapabilityEvidence,
  runtimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'

const {
  supportsMock,
  clearSupportMock,
  resolveEnvironmentMock,
  subscribeSharedMock,
  subscribeLegacyMock,
  sharedCallMock
} = vi.hoisted(() => ({
  supportsMock: vi.fn(),
  clearSupportMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  subscribeSharedMock: vi.fn(),
  subscribeLegacyMock: vi.fn(),
  sharedCallMock: vi.fn()
}))

vi.mock('./runtime-environment-usage-record', () => ({ recordRuntimeEnvironmentUsage: vi.fn() }))
vi.mock('./runtime-environment-abortable-requests', async (importOriginal) => ({
  ...(await importOriginal()),
  sendRemoteRuntimeSharedControlRequestAbortable: sharedCallMock
}))

vi.mock('./runtime-environment-managed-tunnel', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveManagedRuntimeEnvironment: async () => environment()
}))

vi.mock('./runtime-environment-shared-control-support', () => ({
  supportsSharedControl: supportsMock,
  clearSharedControlSupport: clearSupportMock
}))
vi.mock(
  '../../../shared/remote-runtime/host-store/runtime-environment-store',
  async (importOriginal) => ({
    ...(await importOriginal()),
    resolveEnvironment: resolveEnvironmentMock,
    markEnvironmentUsed: vi.fn()
  })
)

vi.mock('./runtime-environment-request-connections', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribeRemoteRuntimeSharedControlRequest: subscribeSharedMock
}))
vi.mock('../../../shared/remote-runtime/remote-runtime-client', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribeRemoteRuntimeRequest: subscribeLegacyMock
}))
import type { subscribeRemoteRuntimeSharedControlRequest } from './runtime-environment-request-connections'
import type { subscribeRemoteRuntimeRequest } from '../../../shared/remote-runtime/remote-runtime-client'

import {
  executeSupportRoutedCall,
  subscribeSupportRoutedRuntimeEnvironment,
  routeRuntimeEnvironmentCallBySupport,
  routeRuntimeEnvironmentSubscriptionBySupport
} from './runtime-environment-support-routing'

beforeEach(() => {
  resetRuntimeEnvironmentCapabilityEvidence()
  supportsMock.mockReset()
  clearSupportMock.mockReset()
  subscribeSharedMock.mockReset()
  subscribeLegacyMock.mockReset()
  sharedCallMock.mockReset()
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

  it.each([
    ['the re-resolved pairing names a replacement runtime', 'replacement', 'runtime'],
    ['the ready connection reached a replacement runtime', 'runtime', 'replacement']
  ])(
    'does not send a runtime-pinned call when %s',
    async (_label, pairedRuntimeId, reachedRuntimeId) => {
      supportsMock
        .mockResolvedValueOnce({ kind: 'stale_incarnation' })
        .mockResolvedValueOnce(acceptedOutcome('capable', reachedRuntimeId))
      resolveEnvironmentMock.mockReturnValue(environment({ runtimeId: pairedRuntimeId }))
      const supported = vi.fn().mockResolvedValue(success())
      const unsupported = vi.fn().mockResolvedValue(success())

      const result = await routeRuntimeEnvironmentCallBySupport({
        userDataPath: '/profile',
        initialEnvironment: environment(),
        expectedRuntimeId: 'runtime',
        method: 'files.write',
        timeoutMs: 100,
        supported,
        unsupported,
        markUsed: vi.fn()
      })

      expect(result).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
      expect(supported).not.toHaveBeenCalled()
      expect(unsupported).not.toHaveBeenCalled()
    }
  )

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

function acceptedOutcome(verdict: 'capable' | 'absent', runtimeId = 'runtime') {
  const environmentId = 'env'
  const pairing = {
    v: 2 as const,
    endpoint: 'ws://host',
    deviceToken: 'token',
    publicKeyB64: 'key'
  }
  const evidence = captureRuntimeEnvironmentCapabilityEvidence(
    environmentId,
    pairedRuntimeConnectionFromOffer(pairing)
  )
  applyRuntimeEnvironmentCapabilityVerdict({ evidence, verdict, runtimeId })
  return runtimeEnvironmentCapabilityOutcome(evidence, verdict, runtimeId)
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

it('cancels only the waiting subscription while a sibling waits on the same support probe', async () => {
  const probe = deferred<ReturnType<typeof acceptedOutcome>>()
  supportsMock.mockReturnValue(probe.promise)
  const supported = vi.fn().mockResolvedValue({ requestId: 'sibling' })
  const unsupported = vi.fn()
  const controller = new AbortController()
  const args = {
    userDataPath: '/profile',
    environment: environment(),
    timeoutMs: 1000,
    isCurrent: () => true,
    supported,
    unsupported
  }
  const abandoned = routeRuntimeEnvironmentSubscriptionBySupport({
    ...args,
    signal: controller.signal
  })
  const sibling = routeRuntimeEnvironmentSubscriptionBySupport(args)
  const rejection = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  expect(supported).not.toHaveBeenCalled()
  probe.resolve(acceptedOutcome('capable'))
  await expect(sibling).resolves.toMatchObject({ subscription: { requestId: 'sibling' } })
  expect(supported).toHaveBeenCalledOnce()
  expect(unsupported).not.toHaveBeenCalled()
})

it.each(['capable', 'absent'] as const)(
  'forwards consumer cancellation into the %s subscription setup',
  async (verdict) => {
    supportsMock.mockResolvedValue(acceptedOutcome(verdict))
    const setup = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    subscribeSharedMock.mockImplementation(
      (...args: Parameters<typeof subscribeRemoteRuntimeSharedControlRequest>) => setup(args[6])
    )
    subscribeLegacyMock.mockImplementation(
      (...args: Parameters<typeof subscribeRemoteRuntimeRequest>) => setup(args[5]?.signal)
    )
    const controller = new AbortController()
    const pending = subscribeSupportRoutedRuntimeEnvironment({
      userDataPath: '/profile',
      environment: environment(),
      method: 'files.watch',
      params: {},
      timeoutMs: 1000,
      callbacks: { onEvent: vi.fn(), onClose: vi.fn() },
      isCurrent: () => true,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(setup).toHaveBeenCalledWith(controller.signal))
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(setup).toHaveBeenCalledOnce()
  }
)

it('reads and cancels a ranged document through its shared authenticated owner', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-range-route-'))
  const path = join(folder, 'document.bin')
  const documents = new RangedFileDocuments()
  const readPermit = deferred<void>()
  let holdReads = false
  try {
    await writeFile(path, 'owner-bound bytes')
    const document = await documents.open('shared-control-owner', async () => {
      if (holdReads) await readPermit.promise
      return path
    })
    supportsMock.mockResolvedValue(acceptedOutcome('capable'))
    const params = {
      id: document.id,
      version: document.version,
      offset: 0,
      length: 5,
      requestToken: 'read'
    }
    const received = deferred<unknown>()
    const readStarted = deferred<void>()
    subscribeSharedMock.mockImplementation(
      async (
        _environmentId: string,
        _connection: unknown,
        _method: string,
        request: typeof params,
        _timeoutMs: number,
        callbacks: { onResponse: (response: unknown) => void }
      ) => {
        const pending = documents.read('shared-control-owner', request)
        if (request.requestToken === 'cancel') readStarted.resolve()
        const result = await pending
        callbacks.onResponse({ id: 'read', ok: true, result, _meta: { runtimeId: 'runtime' } })
        return { requestId: 'read', close: () => {}, sendBinary: () => false }
      }
    )
    subscribeLegacyMock.mockImplementation(async () => {
      await documents.read('disposable-socket-owner', params)
      throw new Error('unreachable')
    })
    await subscribeRuntimeEnvironment('/profile', 'env', 'files.rangeDocumentRead', params, 1000, {
      onEvent: (event) => {
        if (event.type === 'response') received.resolve(event.response)
      },
      onClose: () => {}
    })
    await expect(received.promise).resolves.toMatchObject({
      ok: true,
      result: { version: 1, contentBase64: 'b3duZXI=', bytesRead: 5, eof: false }
    })
    sharedCallMock.mockImplementation(
      async (
        _environmentId: string,
        _connection: unknown,
        method: string,
        request: { id: string; requestToken: string }
      ) => {
        if (method !== 'files.rangeDocumentCancel') throw new Error('unexpected_method')
        documents.cancel('shared-control-owner', request.id, request.requestToken)
        return { id: 'cancel', ok: true, result: { ok: true }, _meta: { runtimeId: 'runtime' } }
      }
    )
    holdReads = true
    const pending = subscribeRuntimeEnvironment(
      '/profile',
      'env',
      'files.rangeDocumentRead',
      { ...params, requestToken: 'cancel' },
      1000,
      { onEvent: () => {}, onClose: () => {} }
    )
    const cancelled = expect(pending).rejects.toThrow('range_document_cancelled')
    await readStarted.promise
    await executeSupportRoutedCall({
      userDataPath: '/profile',
      environment: environment(),
      method: 'files.rangeDocumentCancel',
      params: { id: document.id, requestToken: 'cancel' },
      timeoutMs: 1000
    })
    readPermit.resolve()
    await cancelled
  } finally {
    readPermit.resolve()
    await documents.closeOwner('shared-control-owner')
    await rm(folder, { recursive: true, force: true })
  }
})

it('refuses ranged documents on a host that cannot keep their authenticated shared owner', async () => {
  supportsMock.mockResolvedValue(acceptedOutcome('absent'))
  subscribeLegacyMock.mockResolvedValue({
    requestId: 'legacy',
    close: () => {},
    sendBinary: () => false
  })
  await expect(
    subscribeRuntimeEnvironment(
      '/profile',
      'env',
      'files.rangeDocumentRead',
      {
        id: 'f7592e07-641c-4684-bc54-c1c68086f28a',
        version: 1,
        offset: 0,
        length: 1,
        requestToken: 'read'
      },
      1000,
      { onEvent: () => {}, onClose: () => {} }
    )
  ).rejects.toMatchObject({
    code: 'range_document_unsupported'
  })
})
