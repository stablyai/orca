import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import {
  bindOutgoingOrcadSource,
  bindOutgoingOrcadIncumbent,
  bindReleasedOutgoingOrcadIncumbent
} from '../ssh/orcad-outgoing-source-binding'
import {
  getProviderForPty,
  getSshPtyProvider,
  hasPtyProviderForInspection,
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  sshProvidersByGeneration
} from '../ipc/pty/provider/registry'

const identity = {
  bridgeId: 'bridge',
  terminalId: 'terminal',
  incarnationId: 'incarnation',
  ownerLease: 'owner',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime'
}
const targetId = 'outgoing-control-test'
const appId = `ssh:${targetId}@@terminal`

beforeEach(() => vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1'))
afterEach(() => {
  unregisterSshPtyProvider(targetId)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function fixture() {
  const disposeListener = vi.fn()
  const mux = {
    isDisposed: vi.fn(() => false),
    dispose: vi.fn(),
    notify: vi.fn(),
    request: vi.fn(async () => ({ ready: true })),
    onNotification: vi.fn(() => disposeListener),
    onNotificationByMethod: vi.fn(() => disposeListener),
    onDispose: vi.fn(() => disposeListener)
  }
  const provider = new SshPtyProvider(targetId, mux as never, undefined, 901)
  const source = vi.spyOn(provider, 'getOwnershipTransferSourceIdentity').mockReturnValue(identity)
  registerSshPtyProvider(targetId, provider)
  const release = () => provider.releaseOutgoingSourceControl({ identity, providerGeneration: 901 })
  return { provider, source, mux, disposeListener, release }
}

function publishedFixture() {
  const f = fixture()
  f.provider.installPublishedOwnershipTransferRoute({
    ptyId: appId,
    identity,
    providerGeneration: 901,
    attachmentId: 'attachment',
    capabilities: {
      protocolVersions: [1],
      maxReplayBytes: 1024,
      maxInputIds: 32,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true
    }
  })
  return f
}

it('fences already-queued transfer controls before their first host request', async () => {
  const f = publishedFixture()
  const write = f.provider.writeWithSettlement(appId, 'queued', { operationId: 'queued' })
  const stop = f.provider.shutdown(appId, { immediate: true }).catch((error) => error)
  f.release()
  expect((await write).outcome).not.toBe('accepted')
  expect(await stop).toBeInstanceOf(Error)
  expect(f.mux.request).not.toHaveBeenCalled()
  expect(f.mux.notify).not.toHaveBeenCalled()
})

it.each(['accepted', 'ambiguous'] as const)(
  'does not send queued shutdown or retry after release with %s input in flight',
  async (outcome) => {
    const f = publishedFixture()
    const input = Promise.withResolvers<{ ready: true; accepted: true; duplicate: false }>()
    f.mux.request.mockImplementationOnce(() => input.promise)
    const write = f.provider.writeWithSettlement(appId, 'in flight', { operationId: 'in-flight' })
    await vi.waitFor(() => expect(f.mux.request).toHaveBeenCalledOnce())
    const stop = f.provider.shutdown(appId, { immediate: true }).catch((error) => error)
    f.release()
    if (outcome === 'accepted') {
      input.resolve({ ready: true, accepted: true, duplicate: false })
    } else {
      input.reject(new Error('reply lost'))
    }
    expect((await write).outcome).toBe(outcome === 'accepted' ? 'accepted' : 'unverifiable')
    expect(await stop).toBeInstanceOf(Error)
    expect(f.mux.request).toHaveBeenCalledOnce()
    expect(f.mux.dispose).not.toHaveBeenCalled()
  }
)

it.each(['terminal', appId])(
  'fences new controls via cached provider and registry (%s)',
  async (id) => {
    const f = fixture()
    expect(getProviderForPty(appId)).toBe(f.provider)
    f.release()
    expect(() => getProviderForPty(appId)).toThrow('source_control_released')
    expect(hasPtyProviderForInspection(appId)).toBe(false)
    expect(f.provider.write(id, 'must not be sent')).toBe(false)
    await expect(f.provider.writeWithSettlement(id, 'must not be sent')).resolves.toEqual({
      outcome: 'refused',
      reason: 'write_gate_denied'
    })
    expect(() => f.provider.resize(id, 100, 30)).toThrow('source_control_released')
    expect(() => f.provider.sendSignal(id, 'SIGKILL')).toThrow('source_control_released')
    expect(() => f.provider.clearBuffer(id)).toThrow('source_control_released')
    await expect(f.provider.shutdown(id, { immediate: true })).rejects.toThrow(
      'source_control_released'
    )
    expect(f.mux.request).not.toHaveBeenCalled()
    expect(f.mux.notify).not.toHaveBeenCalled()
    expect(f.mux.dispose).not.toHaveBeenCalled()
    expect(f.disposeListener).not.toHaveBeenCalled()
    expect(getSshPtyProvider(targetId)).toBe(f.provider)
    expect(sshProvidersByGeneration.get(901)).toBe(f.provider)
    await expect(f.provider.requestHostRpc('read-transfer-state', {})).resolves.toEqual({
      ready: true
    })
    expect(getProviderForPty(`ssh:${targetId}@@unrelated`)).toBe(f.provider)
  }
)

it('does not retry an ambiguous transferred control after source release', async () => {
  const f = publishedFixture()
  const reply = Promise.withResolvers<{ ready: true }>()
  f.mux.request.mockImplementationOnce(() => reply.promise)
  const control = f.provider.sendSignal(appId, 'SIGINT').catch((error) => error)
  await vi.waitFor(() => expect(f.mux.request).toHaveBeenCalledOnce())
  f.release()
  reply.reject(new Error('reply lost'))
  expect(await control).toBeInstanceOf(Error)
  expect(f.mux.request).toHaveBeenCalledOnce()
  expect(f.mux.dispose).not.toHaveBeenCalled()
})

it('permits exact retry without rebinding source and keeps the fence when the canary is disabled', () => {
  const f = fixture()
  f.release()
  f.source.mockReturnValue(null)
  expect(f.release).not.toThrow()
  expect(f.source).toHaveBeenCalledOnce()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
  expect(f.release).toThrow('mutation_disabled')
  expect(f.provider.write(appId, 'blocked')).toBe(false)
})

it('retains exact incumbent authority after releasing ordinary dispatch without admitting the old route again', () => {
  const f = fixture()
  const source = bindOutgoingOrcadSource({
    identity,
    ptyId: appId,
    sourceSshTargetId: targetId,
    signal: new AbortController().signal,
    assertAuthority: () => {}
  })
  f.release()
  expect(() => source.assertIncumbent()).not.toThrow()
  const retry = bindOutgoingOrcadIncumbent({
    identity,
    ptyId: appId,
    sourceSshTargetId: targetId,
    signal: new AbortController().signal,
    assertAuthority: () => {}
  })
  expect(() => retry.assertIncumbent()).not.toThrow()
  expect(() => source.assertSource()).toThrow('source_control_released')
  f.source.mockReturnValue({ ...identity, incarnationId: 'replacement' })
  expect(() => source.assertIncumbent()).toThrow('source_authority_changed')
})

it.each([
  'bridgeId',
  'incarnationId',
  'ownerLease',
  'sourceOwnerGeneration',
  'destinationRuntimeId'
] as const)('refuses conflicting %s on retry without removing the original fence', (field) => {
  const f = fixture()
  f.release()
  expect(() =>
    f.provider.releaseOutgoingSourceControl({
      identity: { ...identity, [field]: field === 'sourceOwnerGeneration' ? 2 : 'other' },
      providerGeneration: 901
    })
  ).toThrow('fence_conflict')
  expect(f.provider.write(appId, 'blocked')).toBe(false)
})

it('binds exact released transport after output identity removal without reopening controls', async () => {
  const f = fixture()
  const options = {
    identity,
    ptyId: appId,
    sourceSshTargetId: targetId,
    signal: new AbortController().signal,
    assertAuthority: vi.fn()
  }
  expect(() => bindReleasedOutgoingOrcadIncumbent(options)).toThrow('source_authority_changed')
  f.release()
  f.source.mockReturnValue(null)
  const released = bindReleasedOutgoingOrcadIncumbent(options)
  expect(() => bindOutgoingOrcadIncumbent(options)).toThrow('source_authority_changed')
  expect(() => released.assertIncumbent()).not.toThrow()
  expect(() => released.assertSource()).toThrow('source_control_released')
  await expect(released.request('read-transfer-state', {})).resolves.toEqual({ ready: true })
  expect(f.provider.write(appId, 'blocked')).toBe(false)
  expect(options.assertAuthority).toHaveBeenCalled()
})

it.each([
  'bridgeId',
  'terminalId',
  'incarnationId',
  'ownerLease',
  'sourceOwnerGeneration',
  'destinationRuntimeId'
] as const)('does not accept another released transfer %s', (field) => {
  const f = fixture()
  f.release()
  const changed = { ...identity, [field]: field === 'sourceOwnerGeneration' ? 2 : 'other' }
  expect(f.provider.isOutgoingSourceControlReleased(appId, changed)).toBe(false)
  expect(() =>
    bindReleasedOutgoingOrcadIncumbent({
      identity: changed,
      ptyId: appId,
      sourceSshTargetId: targetId,
      signal: new AbortController().signal,
      assertAuthority: () => {}
    })
  ).toThrow(field === 'terminalId' ? 'source_route_invalid' : 'source_authority_changed')
  expect(f.provider.isOutgoingSourceControlReleased(appId, identity)).toBe(true)
})

it.each(['provider', 'generation', 'disabled', 'aborted', 'authority'] as const)(
  'rechecks released source authority after %s changes',
  (change) => {
    const f = fixture()
    f.release()
    f.source.mockReturnValue(null)
    const controller = new AbortController()
    const assertAuthority = vi.fn()
    const released = bindReleasedOutgoingOrcadIncumbent({
      identity,
      ptyId: appId,
      sourceSshTargetId: targetId,
      signal: controller.signal,
      assertAuthority
    })
    if (change === 'provider') {
      fixture()
    }
    if (change === 'generation') {
      Object.defineProperty(f.provider, 'providerGeneration', { value: 902 })
    }
    if (change === 'disabled') {
      vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
    }
    if (change === 'aborted') {
      controller.abort()
    }
    if (change === 'authority') {
      assertAuthority.mockImplementation(() => {
        throw new Error('profile_authority_changed')
      })
    }
    expect(() => released.assertIncumbent()).toThrow()
    expect(f.mux.request).not.toHaveBeenCalled()
  }
)

it.each(['provider', 'source', 'disabled'] as const)(
  'refuses %s mismatch before fencing',
  (change) => {
    const f = fixture()
    if (change === 'source') {
      f.source.mockReturnValue({ ...identity, incarnationId: 'replaced' })
    }
    if (change === 'disabled') {
      vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
    }
    expect(() =>
      f.provider.releaseOutgoingSourceControl({
        identity,
        providerGeneration: change === 'provider' ? 900 : 901
      })
    ).toThrow()
    expect(f.provider.isOutgoingSourceControlReleased(appId)).toBe(false)
    expect(getProviderForPty(appId)).toBe(f.provider)
  }
)
