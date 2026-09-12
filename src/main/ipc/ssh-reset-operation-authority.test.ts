import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'
import { sshRelayResetTargetRoutingDigest } from '../ssh/ssh-relay-reset-session-binding'
import { SshResetOperationAuthorities } from './ssh-reset-operation-authority'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { fixture as wireFixture } from '../ssh/ssh-relay-network-test-fixture'
import { parseSshRelayResetArchive } from '../ssh/ssh-relay-reset-archive'

function fixture(
  retainedMux?: Pick<SshChannelMultiplexer, 'assertRelayResetAcknowledgmentDrained'>
) {
  const target: SshTarget = {
    id: 'target',
    generation: 1,
    label: 'host',
    host: 'example.test',
    port: 22,
    username: 'user'
  }
  const session = {}
  const sessions = new Map([['target', session]])
  const authorities = new SshResetOperationAuthorities(sessions)
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId: target.id,
    targetGeneration: 1,
    targetRoutingDigest: sshRelayResetTargetRoutingDigest(target),
    clientInstanceId: 'client',
    serverBuildId: 'build',
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/bun',
      runtimeKind: 'bun',
      sockPath: '/socket',
      credentialFile: '/credential',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'operation',
      runtimeIncarnation: 'runtime',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  const selection = {
    version: 1 as const,
    intentSha256: sshRelayResetRecordDigest(intent),
    clientIncarnation: randomUUID(),
    retiredAt: 1,
    leases: [],
    routes: []
  }
  const options = {
    intent,
    selection,
    session,
    mux: { assertRelayResetAcknowledgmentDrained: vi.fn() },
    readTarget: vi.fn((): SshTarget | undefined => target),
    assertLiveAuthority: vi.fn(),
    assertCapturedIdentity: vi.fn()
  }
  const operation = authorities.retain({ ...options, mux: retainedMux ?? options.mux })
  const acknowledgment = {
    version: 1 as const,
    operationId: 'operation',
    runtimeIncarnation: 'runtime',
    prepared: true as const
  }
  const capture = vi.fn(
    (_ack: typeof acknowledgment, _intent: typeof intent): undefined => undefined
  )
  const prepare = () => operation.onPreparedAcknowledgment(acknowledgment, intent, capture)
  return {
    target,
    session,
    sessions,
    authorities,
    intent,
    selection,
    options,
    operation,
    acknowledgment,
    capture,
    prepare
  }
}

it('switches from live to retained captured identity only after synchronous validated preparation', () => {
  const f = fixture()
  f.operation.assertAuthority()
  expect(f.operation.assertPreparedAuthority).toThrow('preparation_unconfirmed')
  f.prepare()
  expect(f.operation.preparationAcknowledgment).toEqual(f.acknowledgment)
  expect(Object.isFrozen(f.operation.preparationAcknowledgment)).toBe(true)
  expect(f.options.mux.assertRelayResetAcknowledgmentDrained).toHaveBeenCalledWith(f.intent.request)
  expect(f.capture).toHaveBeenCalledWith(f.acknowledgment, f.intent)
  expect(Object.isFrozen(f.capture.mock.calls[0][0])).toBe(true)
  f.options.assertLiveAuthority.mockImplementation(() => {
    throw new Error('transport closed')
  })
  f.operation.assertAuthority()
  f.operation.assertPreparedAuthority()
  f.options.assertCapturedIdentity.mockImplementation(() => {
    throw new Error('captured mux changed')
  })
  expect(f.operation.assertAuthority).toThrow('captured mux changed')
})

it('requires explicit exact session removal and refuses a replacement afterward', () => {
  const f = fixture()
  f.prepare()
  const local = vi.fn(() => f.operation.assertPreparedAuthority())
  f.operation.removeCapturedSession(local)
  expect(f.sessions.has('target')).toBe(false)
  f.operation.assertAuthority()
  f.operation.removeCapturedSession(local)
  f.sessions.set('target', {})
  expect(f.operation.assertAuthority).toThrow('session_changed')
  expect(() => f.operation.removeCapturedSession(local)).toThrow('session_changed')
  expect(f.sessions.has('target')).toBe(true)
})

it.each(['absent', 'replacement'])(
  'does not mistake an %s raw session for intentional removal',
  (change) => {
    const f = fixture()
    f.prepare()
    if (change === 'absent') {
      f.sessions.delete('target')
    } else {
      f.sessions.set('target', {})
    }
    expect(f.operation.assertAuthority).toThrow('session_changed')
    expect(() => f.operation.removeCapturedSession(() => {})).toThrow('session_changed')
  }
)

it.each(['routing', 'generation', 'missing'])(
  'refuses changed target %s after preparation',
  (change) => {
    const f = fixture()
    f.prepare()
    if (change === 'routing') {
      f.target.jumpHost = 'replacement'
    }
    if (change === 'generation') {
      f.target.generation = 2
    }
    if (change === 'missing') {
      f.options.readTarget.mockReturnValue(undefined)
    }
    expect(f.operation.assertAuthority).toThrow('target_changed')
  }
)

it('retains the slot after failure and rejects overlapping or replacement operations', () => {
  const f = fixture()
  f.capture.mockImplementationOnce(() => {
    throw new Error('drain failed')
  })
  expect(f.prepare).toThrow('drain failed')
  expect(f.operation.preparationAcknowledgment).toBeUndefined()
  expect(f.authorities.get('target')).toBe(f.operation)
  expect(f.authorities.get('missing')).toBeUndefined()
  expect(f.operation.assertPreparedAuthority).toThrow('preparation_unconfirmed')
  expect(() => f.authorities.retain(f.options)).toThrow('already_retained')
  expect(() =>
    f.authorities.retain({
      ...f.options,
      intent: {
        ...f.intent,
        request: { ...f.intent.request, operationId: 'replacement' }
      }
    })
  ).toThrow()
  f.prepare()
  expect(f.prepare).toThrow('repeated')
})

it('rejects changed intent and actual ACK context before invoking capture', () => {
  const f = fixture()
  expect(() =>
    f.operation.onPreparedAcknowledgment(
      f.acknowledgment,
      {
        ...f.intent,
        endpoint: { ...f.intent.endpoint, sockPath: '/other' }
      },
      f.capture
    )
  ).toThrow('intent_changed')
  f.options.mux.assertRelayResetAcknowledgmentDrained.mockImplementation(() => {
    throw new Error('ACK context missing')
  })
  expect(f.prepare).toThrow('ACK context missing')
  expect(f.capture).not.toHaveBeenCalled()
})

it('rejects asynchronous capture and reentrant preparation', () => {
  const f = fixture()
  expect(() =>
    f.operation.onPreparedAcknowledgment(f.acknowledgment, f.intent, (() =>
      Promise.resolve()) as unknown as () => undefined)
  ).toThrow('not_synchronous')
  f.capture.mockImplementationOnce(() => {
    f.prepare()
    return undefined
  })
  expect(f.prepare).toThrow('repeated')
  expect(f.operation.assertPreparedAuthority).toThrow('preparation_unconfirmed')
})

it('rechecks live owner authority after the capture callback before accepting preparation', () => {
  const f = fixture()
  f.capture.mockImplementationOnce(() => {
    f.options.assertLiveAuthority.mockImplementation(() => {
      throw new Error('owner changed')
    })
    return undefined
  })
  expect(f.prepare).toThrow('owner changed')
  expect(f.operation.assertPreparedAuthority).toThrow('preparation_unconfirmed')
})

it('requires local retirement before removal and rechecks identity after its callback', () => {
  const f = fixture()
  expect(() => f.operation.removeCapturedSession(() => {})).toThrow('preparation_unconfirmed')
  f.prepare()
  expect(() =>
    f.operation.removeCapturedSession(() => {
      throw new Error('leases not retired')
    })
  ).toThrow('leases not retired')
  expect(f.sessions.get('target')).toBe(f.session)
  expect(() =>
    f.operation.removeCapturedSession(() => {
      f.sessions.set('target', {})
    })
  ).toThrow('session_changed')
  expect(f.sessions.has('target')).toBe(true)
})

it('establishes prepared authority inside the real mux reply before adjacent disposal', async () => {
  const wire = wireFixture()
  const f = fixture(wire.mux)
  wire.dispatcher.onRequest('relay.reset', async () => f.acknowledgment)
  wire.mux.fenceForRelayReset()
  await wire.mux.waitForRelayResetDrain(new AbortController().signal)
  await wire.mux.request('relay.reset', f.intent.request, {
    beforeResolve: (value) => {
      f.operation.onPreparedAcknowledgment(value as typeof f.acknowledgment, f.intent, f.capture)
      wire.mux.dispose()
      f.options.assertLiveAuthority.mockImplementation(() => {
        throw new Error('transport disposed')
      })
    }
  })
  expect(wire.mux.isDisposed()).toBe(true)
  f.operation.assertPreparedAuthority()
  f.operation.removeCapturedSession(() => {})
  f.operation.assertAuthority()
  expect(f.sessions.has('target')).toBe(false)
})

function completedArchive(f: ReturnType<typeof fixture>) {
  const receipt = {
    version: 1,
    intentSha256: f.operation.intentDigest,
    selectionSha256: f.operation.selectionDigest,
    acknowledgment: f.acknowledgment
  }
  return parseSshRelayResetArchive(
    {
      version: 1,
      intent: f.intent,
      selection: f.operation.selection,
      receipt,
      completion: {
        version: 1,
        intentSha256: receipt.intentSha256,
        selectionSha256: receipt.selectionSha256,
        receiptSha256: sshRelayResetRecordDigest(receipt),
        localRetired: true
      }
    },
    f.intent
  )
}

it('releases only a removed captured session with matching completed evidence and successful fence release', () => {
  const f = fixture()
  f.prepare()
  const archive = completedArchive(f)
  const release = vi.fn((): undefined => undefined)
  expect(() => f.operation.release(archive, () => {}, release)).toThrow('release_not_admitted')
  expect(release).not.toHaveBeenCalled()
  f.operation.removeCapturedSession(() => {})
  release.mockImplementationOnce(() => {
    throw new Error('forward release failed')
  })
  expect(() => f.operation.release(archive, () => {}, release)).toThrow('forward release failed')
  expect(f.authorities.get('target')).toBe(f.operation)
  f.operation.release(archive, () => {}, release)
  expect(f.authorities.get('target')).toBeUndefined()
  expect(f.operation.assertAuthority).toThrow('slot_changed')
})

it('retains the slot when release changes local authority and rejects reentrant release', () => {
  const f = fixture()
  f.prepare()
  f.operation.removeCapturedSession(() => {})
  const archive = completedArchive(f)
  expect(() =>
    f.operation.release(
      archive,
      () => {},
      () => {
        f.operation.release(
          archive,
          () => {},
          () => undefined
        )
        return undefined
      }
    )
  ).toThrow('release_not_admitted')
  expect(f.authorities.get('target')).toBe(f.operation)
  expect(() =>
    f.operation.release(
      archive,
      () => {},
      () => {
        f.sessions.set('target', {})
        return undefined
      }
    )
  ).toThrow('session_changed')
  expect(f.authorities.get('target')).toBe(f.operation)
})
