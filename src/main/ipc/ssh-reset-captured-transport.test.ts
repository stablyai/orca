import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'
import type { SshRelaySession } from '../ssh/ssh-relay-session'
import { SshConnectionWorkLedger } from '../ssh/ssh-connection-work-ledger'
import { activeSessions } from './ssh-active-relay-sessions'
import { captureSshResetTransportRetirement } from './ssh-reset-captured-transport'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { SshResetOperationAuthorities } from './ssh-reset-operation-authority'
import { sshRelayResetTargetRoutingDigest } from '../ssh/ssh-relay-reset-session-binding'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'
import { assertSshBrowserResourcesAbsent } from '../browser/ssh-browser-route-lifetimes'
import { resolveSshBrowserNetworkExecutionRoute } from '../browser/ssh-browser-network-execution-route'
import type { SshBrowserNetworkExecutionRouteDependencies } from '../browser/ssh-browser-network-execution-route'
import type { RelayOwnerResetRequest } from '../../shared/relay-owner-reset-contract'

const targets: string[] = []
afterEach(() => {
  for (const target of targets.splice(0)) {
    activeSessions.delete(target)
  }
})

async function fixture(
  drain = true,
  options: {
    begin?: boolean
    prepared?: boolean
    stable?: boolean
    control?: 'missing' | 'unbound' | 'duplicate'
    beforeBegin?: (ledger: SshConnectionWorkLedger) => void
  } = {}
) {
  const targetId = randomUUID()
  const target = {
    id: targetId,
    generation: 1,
    label: 'host',
    host: 'example.test',
    port: 22,
    username: 'user'
  }
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId,
    targetGeneration: 1,
    targetRoutingDigest: sshRelayResetTargetRoutingDigest(target),
    clientInstanceId: 'client',
    serverBuildId: 'build',
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/bun',
      runtimeKind: 'bun',
      sockPath: '/relay/socket',
      credentialFile: '/relay/credential',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'runtime',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  targets.push(targetId)
  let status = 'connected'
  const ledger = new SshConnectionWorkLedger()
  const controlChannel = {}
  const control = ledger.beginChannelOpen()
  if (options.control !== 'unbound') {
    control.bind(controlChannel)
  }
  if (options.control === 'duplicate') {
    ledger.beginChannelOpen().bind(controlChannel)
  }
  const fenceWorkForReset = vi.fn((channel?: object) => ledger.fenceForReset(channel))
  const connection = { getState: () => ({ status }), fenceWorkForReset } as unknown as SshConnection
  let currentConnection: SshConnection | undefined = connection
  let retired = false
  const events: string[] = []
  const captured = {
    connection,
    mux: {
      getSourceChannel: vi.fn(() => (options.control === 'missing' ? undefined : controlChannel)),
      waitForRelayResetDrain: vi.fn(async () => {}),
      assertRelayResetAcknowledgmentDrained: vi.fn()
    },
    drainNetworkTunnels: vi.fn(async () => {}),
    assertNetworkTunnelsDrained: vi.fn(),
    confirmNetworkResetRetirement: vi.fn(),
    begin: vi.fn(() => events.push('begin')),
    assertCurrent: vi.fn(),
    assertIdentity: vi.fn(),
    retire: vi.fn((assertAuthority: () => void) => {
      assertAuthority()
      events.push('session')
      retired = true
    }),
    assertRetired: vi.fn(() => {
      if (!retired) {
        throw new Error('session not retired')
      }
    })
  }
  const session = { captureResetRetirement: () => captured } as unknown as SshRelaySession
  activeSessions.set(targetId, session)
  const connections = {
    getConnection: vi.fn(() => currentConnection),
    disconnectConnection: vi.fn(async (target: string, selected: SshConnection) => {
      expect(target).toBe(targetId)
      expect(selected).toBe(connection)
      events.push('disconnect')
      control.close()
      status = 'disconnected'
      currentConnection = undefined
    })
  }
  const cleanup = {
    removeAndWait: vi.fn(async () => {
      events.push('forwards')
    }),
    assertRemoved: vi.fn()
  }
  const forwards = {
    captureForwardCleanup: vi.fn(() => cleanup),
    fenceForwardAdmission: vi.fn(() => ({
      assertClosed: vi.fn(),
      drain: vi.fn(async () => {}),
      assertDrained: vi.fn(),
      assertResetRetirementSupported: vi.fn(),
      reconcileResetRetirement: vi.fn(),
      release: vi.fn((assertAuthorized: () => void) => {
        assertAuthorized()
        return { assertReleased: vi.fn() }
      })
    }))
  }
  const assertAuthority = vi.fn()
  const authority = options.stable
    ? new SshResetOperationAuthorities(activeSessions).retain({
        intent,
        selection: {
          version: 1,
          intentSha256: sshRelayResetRecordDigest(intent),
          clientIncarnation: randomUUID(),
          retiredAt: 1,
          leases: [],
          routes: []
        },
        session,
        mux: captured.mux,
        readTarget: () => target,
        assertLiveAuthority: assertAuthority,
        assertCapturedIdentity: captured.assertIdentity
      })
    : undefined
  const handle = captureSshResetTransportRetirement({
    targetId,
    session,
    connections,
    forwards,
    assertAuthority: authority?.assertAuthority ?? assertAuthority,
    intent: options.prepared || options.stable ? intent : undefined,
    removeCapturedSession: authority?.removeCapturedSession
  })
  options.beforeBegin?.(ledger)
  if (options.begin !== false) {
    handle.begin()
  }
  if (drain) {
    await handle.drain(new AbortController().signal)
  }
  const assertLocalRetired = vi.fn()
  return {
    handle,
    intent,
    authority,
    assertAuthority,
    captured,
    session,
    connections,
    cleanup,
    events,
    targetId,
    assertLocalRetired,
    forwards,
    ledger,
    controlChannel,
    fenceWorkForReset,
    replaceConnection: () => {
      currentConnection = {} as SshConnection
      return currentConnection
    }
  }
}

it('cannot retire before admitted publications drain and their listeners are captured', async () => {
  const f = await fixture(false)
  expect(f.handle.assertDrainedForAcknowledgment).toThrow('publication_not_drained')
  expect(f.forwards.captureForwardCleanup).not.toHaveBeenCalled()
  await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('publication_not_drained')
  expect(f.captured.retire).not.toHaveBeenCalled()
  const pending = Promise.withResolvers<void>()
  f.captured.mux.waitForRelayResetDrain.mockReturnValueOnce(pending.promise)
  const draining = f.handle.drain(new AbortController().signal)
  await Promise.resolve()
  expect(f.forwards.captureForwardCleanup).not.toHaveBeenCalled()
  pending.resolve()
  await draining
  expect(f.forwards.captureForwardCleanup).toHaveBeenCalledOnce()
  f.handle.assertDrainedForAcknowledgment()
  expect(f.captured.assertNetworkTunnelsDrained).toHaveBeenCalledOnce()
  expect(f.captured.mux.assertRelayResetAcknowledgmentDrained).toHaveBeenCalledOnce()
  await f.handle.teardown(f.assertLocalRetired)
})

it('binds synchronous preparation to the captured intent before permitting cleanup', async () => {
  const f = await fixture(true, { prepared: true })
  const acknowledgment = {
    version: 1 as const,
    operationId: 'reset',
    runtimeIncarnation: 'runtime',
    prepared: true as const
  }
  await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('preparation_unconfirmed')
  expect(() =>
    f.handle.onPreparedAcknowledgment(acknowledgment, {
      ...f.intent,
      endpoint: { ...f.intent.endpoint, sockPath: '/other' }
    })
  ).toThrow('intent_mismatch')
  expect(() =>
    f.handle.onPreparedAcknowledgment({ ...acknowledgment, operationId: 'other' }, f.intent)
  ).toThrow('acknowledgment_invalid')
  expect(f.captured.confirmNetworkResetRetirement).not.toHaveBeenCalled()
  f.handle.onPreparedAcknowledgment(acknowledgment, f.intent)
  expect(f.captured.confirmNetworkResetRetirement).toHaveBeenCalledExactlyOnceWith(f.intent.request)
  expect(f.captured.mux.assertRelayResetAcknowledgmentDrained).toHaveBeenCalledWith(
    f.intent.request
  )
  expect(() => f.handle.onPreparedAcknowledgment(acknowledgment, f.intent)).toThrow('repeated')
  await f.handle.teardown(f.assertLocalRetired)
  const admission = f.forwards.fenceForwardAdmission.mock.results[0].value
  expect(admission.reconcileResetRetirement).toHaveBeenCalledExactlyOnceWith(f.intent.request)
  expect(f.events).toEqual(['begin', 'session', 'forwards', 'disconnect'])
})

it('composes retained operation authority with captured cleanup after the live binding disappears', async () => {
  const f = await fixture(true, { stable: true })
  expect(() => f.handle.releaseForwardAdmission(f.assertLocalRetired)).toThrow(
    'retirement_unconfirmed'
  )
  f.authority!.onPreparedAcknowledgment(
    {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'runtime',
      prepared: true
    },
    f.intent,
    f.handle.onPreparedAcknowledgment
  )
  f.assertAuthority.mockImplementation(() => {
    throw new Error('old live transport closed')
  })
  f.authority!.assertPreparedAuthority()
  const retired = await f.handle.teardown(f.assertLocalRetired)
  retired.assertRetired()
  f.authority!.assertPreparedAuthority()
  expect(activeSessions.has(f.targetId)).toBe(false)
  expect(f.captured.assertIdentity).toHaveBeenCalled()
  f.handle.releaseForwardAdmission(retired.assertRetired)
  f.handle.releaseForwardAdmission(retired.assertRetired)
  retired.assertRetired()
  const admission = f.forwards.fenceForwardAdmission.mock.results[0].value
  expect(admission.release).toHaveBeenCalledOnce()
  admission.release.mock.results[0].value.assertReleased.mockImplementationOnce(() => {
    throw new Error('replacement admission')
  })
  expect(retired.assertRetired).toThrow('replacement admission')
  activeSessions.set(f.targetId, {} as SshRelaySession)
  expect(retired.assertRetired).toThrow('session_changed')
  expect(f.authority!.assertPreparedAuthority).toThrow('session_changed')
})

it('refuses forward capabilities before reset and retains drain failures before proof transition', async () => {
  const f = await fixture(false, { prepared: true })
  const admission = f.forwards.fenceForwardAdmission.mock.results[0].value
  admission.assertResetRetirementSupported.mockImplementation(() => {
    throw new Error('opaque forward')
  })
  await expect(f.handle.drain(new AbortController().signal)).rejects.toThrow('opaque forward')
  expect(f.forwards.captureForwardCleanup).not.toHaveBeenCalled()
  admission.assertResetRetirementSupported.mockReset()
  await f.handle.drain(new AbortController().signal)
  admission.assertDrained.mockImplementation(() => {
    throw new Error('forward uncertain')
  })
  expect(() =>
    f.handle.onPreparedAcknowledgment(
      {
        version: 1,
        operationId: 'reset',
        runtimeIncarnation: 'runtime',
        prepared: true
      },
      f.intent
    )
  ).toThrow('forward uncertain')
  expect(f.captured.confirmNetworkResetRetirement).not.toHaveBeenCalled()
  await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('preparation_unconfirmed')
})

it('refuses changed connection authority after drain before capturing listeners', async () => {
  const f = await fixture(false)
  f.captured.mux.waitForRelayResetDrain.mockImplementationOnce(async () => {
    f.replaceConnection()
  })
  await expect(f.handle.drain(new AbortController().signal)).rejects.toThrow('connection_changed')
  expect(f.forwards.captureForwardCleanup).not.toHaveBeenCalled()
  expect(f.captured.retire).not.toHaveBeenCalled()
})

it('retires session and forwards before exact connection cleanup, then supports retries', async () => {
  const f = await fixture()
  const result = await f.handle.teardown(f.assertLocalRetired)
  expect(f.events).toEqual(['begin', 'session', 'forwards', 'disconnect'])
  expect(activeSessions.has(f.targetId)).toBe(false)
  result.assertRetired()
  await f.handle.teardown(f.assertLocalRetired)
  expect(f.connections.disconnectConnection).toHaveBeenCalledTimes(1)
  expect(f.assertLocalRetired).toHaveBeenCalled()
})

it.each(['session', 'connection'])(
  'preserves a replacement %s installed during forward cleanup',
  async (kind) => {
    const f = await fixture()
    const replacement = {} as SshRelaySession
    f.cleanup.removeAndWait.mockImplementationOnce(async () => {
      if (kind === 'session') {
        activeSessions.set(f.targetId, replacement)
      } else {
        f.replaceConnection()
      }
    })
    await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('changed')
    expect(f.connections.disconnectConnection).not.toHaveBeenCalled()
    expect(activeSessions.get(f.targetId)).toBe(kind === 'session' ? replacement : f.session)
  }
)

it('rechecks lease/route retirement after forward cleanup before disconnect', async () => {
  const f = await fixture()
  f.cleanup.removeAndWait.mockImplementationOnce(async () => {
    f.assertLocalRetired.mockImplementation(() => {
      throw new Error('lease replaced')
    })
  })
  await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('lease replaced')
  expect(f.connections.disconnectConnection).not.toHaveBeenCalled()
  expect(activeSessions.get(f.targetId)).toBe(f.session)
})

it('retains the captured session across uncertain closure and retries it', async () => {
  const f = await fixture()
  f.connections.disconnectConnection.mockRejectedValueOnce(new Error('disconnect uncertain'))
  await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('disconnect uncertain')
  expect(activeSessions.get(f.targetId)).toBe(f.session)
  await f.handle.teardown(f.assertLocalRetired)
  expect(f.connections.disconnectConnection).toHaveBeenCalledTimes(2)
  expect(activeSessions.has(f.targetId)).toBe(false)
})

it('does not remove a replacement session after awaited disconnect', async () => {
  const f = await fixture()
  const disconnect = f.connections.disconnectConnection.getMockImplementation()!
  const replacement = {} as SshRelaySession
  f.connections.disconnectConnection.mockImplementationOnce(async (...args) => {
    await disconnect(...args)
    activeSessions.set(f.targetId, replacement)
  })
  await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('session_changed')
  expect(activeSessions.get(f.targetId)).toBe(replacement)
})

it.each(['missing', 'unbound', 'duplicate'] as const)(
  'refuses %s relay control identity',
  async (control) => {
    await expect(fixture(false, { control })).rejects.toThrow('control_channel_unproven')
  }
)

it('exempts only the captured relay channel and retains a single fence across retries', async () => {
  let close!: () => void
  const f = await fixture(false, {
    beforeBegin: (ledger) => {
      const channel = ledger.beginChannelOpen()
      channel.bind({})
      close = channel.close
    }
  })
  f.handle.begin()
  expect(f.fenceWorkForReset).toHaveBeenCalledExactlyOnceWith(f.controlChannel)
  expect(() => f.ledger.beginChannelOpen()).toThrow('admission_closed')
  const controller = new AbortController()
  const waiting = f.handle.drain(controller.signal)
  controller.abort(new Error('observer cancelled'))
  await expect(waiting).rejects.toThrow('observer cancelled')
  expect(f.forwards.captureForwardCleanup).not.toHaveBeenCalled()
  close()
  await f.handle.drain(new AbortController().signal)
  await f.handle.teardown(f.assertLocalRetired)
})

it('waits for nested work admitted by a still-running pre-fence operation', async () => {
  const resume = Promise.withResolvers<void>()
  let operation!: Promise<void>
  let close!: () => void
  const f = await fixture(false, {
    beforeBegin: (ledger) => {
      operation = ledger.run(async () => {
        await resume.promise
        const channel = ledger.beginChannelOpen()
        channel.bind({})
        close = channel.close
      })
    }
  })
  const done = vi.fn()
  const draining = f.handle.drain(new AbortController().signal).then(done)
  resume.resolve()
  await operation
  expect(done).not.toHaveBeenCalled()
  close()
  await draining
  expect(done).toHaveBeenCalledOnce()
})

it('retains transport loss through drain retries and refuses all teardown', async () => {
  const f = await fixture()
  f.ledger.markTransportUnverifiable()
  expect(f.handle.assertDrainedForAcknowledgment).toThrow('transport_unverifiable')
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(f.handle.drain(new AbortController().signal)).rejects.toThrow(
      'transport_unverifiable'
    )
    await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('transport_unverifiable')
  }
  expect(f.captured.retire).not.toHaveBeenCalled()
  expect(f.cleanup.removeAndWait).not.toHaveBeenCalled()
  expect(f.connections.disconnectConnection).not.toHaveBeenCalled()
})

it.each(['network', 'mux'])(
  'refuses acknowledgment when %s proof changes after drain',
  async (kind) => {
    const f = await fixture()
    const assertion =
      kind === 'network'
        ? f.captured.assertNetworkTunnelsDrained
        : f.captured.mux.assertRelayResetAcknowledgmentDrained
    assertion.mockImplementation(() => {
      throw new Error('drain proof changed')
    })
    expect(f.handle.assertDrainedForAcknowledgment).toThrow('drain proof changed')
    expect(f.captured.retire).not.toHaveBeenCalled()
    expect(f.connections.disconnectConnection).not.toHaveBeenCalled()
  }
)

it('rejects control channel replacement before begin without fencing other resources', async () => {
  const f = await fixture(false, { begin: false })
  f.captured.mux.getSourceChannel.mockReturnValue({})
  expect(() => f.handle.begin()).toThrow('control_channel_changed')
  expect(f.fenceWorkForReset).not.toHaveBeenCalled()
  expect(f.forwards.fenceForwardAdmission).not.toHaveBeenCalled()
})

it('rechecks direct-work failure after forward cleanup before disconnect', async () => {
  const f = await fixture()
  f.cleanup.removeAndWait.mockImplementationOnce(async () => f.ledger.markTransportUnverifiable())
  await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('transport_unverifiable')
  expect(f.connections.disconnectConnection).not.toHaveBeenCalled()
})

it('reconciles a registered relay browser route only after local close and exact disconnect', async () => {
  const f = await fixture(false, { prepared: true, begin: false })
  const ready = Promise.withResolvers<PassThrough>()
  const source = new PassThrough({ emitClose: false })
  const tunnel = {
    open: vi.fn(() => ready.promise),
    fail: vi.fn(),
    retirementConfirmed: false,
    resetRetirementRequest: undefined as RelayOwnerResetRequest | undefined
  }
  f.captured.confirmNetworkResetRetirement.mockImplementation((...args: unknown[]) => {
    tunnel.resetRetirementRequest = args[0] as RelayOwnerResetRequest
  })
  const release = vi.fn(async () => {})
  const removeAuthorityAbort = vi.fn()
  // Simulated registered transport; resolver, browser sockets and retirement evidence are real.
  const openNetworkTunnel = vi.fn(async () => ({
    tunnel,
    connection: f.captured.connection,
    assertCurrent: vi.fn(),
    assertAdmission: vi.fn(),
    release
  })) as unknown as SshBrowserNetworkExecutionRouteDependencies['openNetworkTunnel']
  const route = await resolveSshBrowserNetworkExecutionRoute(
    {
      executionHost: {
        kind: 'ssh',
        targetId: f.targetId,
        providerEpoch: 'provider',
        connectionGeneration: 1
      },
      runtimeId: 'runtime',
      runtimeRevision: 1
    },
    {
      connectionManager: f.connections,
      isCurrentAuthority: () => true,
      registerAuthorityAbort: () => removeAuthorityAbort,
      openNetworkTunnel
    }
  )
  const socket = route.connect({ host: 'internal', port: 443 })
  f.handle.begin()
  expect(openNetworkTunnel).toHaveBeenCalledExactlyOnceWith(f.targetId, {
    signal: expect.any(AbortSignal),
    onFailure: expect.any(Function)
  })
  expect(tunnel.open).toHaveBeenCalledExactlyOnceWith({ host: 'internal', port: 443 })
  const connected = vi.fn()
  socket.on('connect', connected)
  const closed = vi.fn()
  const closing = Promise.resolve(route.close()).then(closed)
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow('not_drained')
  ready.resolve(source)
  await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
  expect(closed).not.toHaveBeenCalled()
  socket.destroy()
  await vi.waitFor(() => expect(source.destroyed).toBe(true))
  expect(closed).not.toHaveBeenCalled()
  source.emit('close')
  await closing
  expect(removeAuthorityAbort).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
  expect(tunnel.fail).not.toHaveBeenCalled()
  await f.handle.drain(new AbortController().signal)
  expect(tunnel.resetRetirementRequest).toBeUndefined()
  f.handle.onPreparedAcknowledgment(
    {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'runtime',
      prepared: true
    },
    f.intent
  )
  expect(tunnel.resetRetirementRequest).toEqual(f.intent.request)
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow('not_drained')
  f.connections.disconnectConnection.mockRejectedValueOnce(new Error('disconnect unconfirmed'))
  await expect(f.handle.teardown(f.assertLocalRetired)).rejects.toThrow('disconnect unconfirmed')
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow('not_drained')
  const original = f.connections.disconnectConnection.getMockImplementation()!
  const stopped = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  f.connections.disconnectConnection.mockImplementationOnce(async (...args) => {
    entered.resolve()
    await stopped.promise
    return original(...args)
  })
  const retiring = f.handle.teardown(f.assertLocalRetired)
  await entered.promise
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow('not_drained')
  stopped.resolve()
  const proof = await retiring
  proof.assertRetired()
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).not.toThrow()
})
