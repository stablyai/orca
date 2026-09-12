import { beforeEach, expect, it, vi } from 'vitest'
import { retainOrcadLiveSuccessorSession } from './orcad-live-successor-session'
import { rotateSshProviderAuthority } from './ssh-provider-authority'

const mocks = vi.hoisted(() => ({
  sessions: new Map(),
  manager: vi.fn(),
  resume: vi.fn(),
  shutdown: vi.fn(),
  reset: vi.fn(),
  connecting: new Set<string>(),
  reconnecting: new Set<string>(),
  resetting: new Set<string>(),
  testing: new Set<string>(),
  probes: vi.fn()
}))
vi.mock('../ipc/ssh-connect-attempt-registry', () => ({
  assertSshConnectsNotFenced: mocks.shutdown,
  connectInFlight: mocks.connecting,
  pendingTransportReconnects: mocks.reconnecting,
  resetRelayInFlight: mocks.resetting,
  testingTargets: mocks.testing,
  hasSshTestConnectionProbes: mocks.probes
}))
vi.mock('../ipc/ssh-reset-production-state', () => ({
  assertSshResetAdmissionAllowed: mocks.reset
}))
vi.mock('../ipc/ssh-active-relay-sessions', () => ({ activeSessions: mocks.sessions }))
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: mocks.manager,
  getSshTargetRegistryStore: vi.fn()
}))
vi.mock('./orcad-saved-source-resume', () => ({ resumeOrcadSavedSshSource: mocks.resume }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.sessions.clear()
  for (const set of [mocks.connecting, mocks.reconnecting, mocks.resetting, mocks.testing]) {
    set.clear()
  }
})

function fixture() {
  const target = {
    id: 'source',
    label: 'Source',
    host: 'host',
    username: 'user',
    port: 22,
    generation: 1
  }
  const connection = {
    getState: () => ({ status: 'connected' }),
    getTarget: vi.fn(() => ({ ...target }))
  }
  const manager = {
    getConnection: vi.fn((): typeof connection | undefined => connection),
    connect: vi.fn(),
    connectExclusive: vi.fn()
  }
  mocks.manager.mockReturnValue(manager)
  const capture = {
    sourceSshTargetId: 'source',
    sourceSshTargetGeneration: 1,
    identity: { ownerLease: 'lease' },
    source: { endpoint: '/saved.sock', incumbentVersion: 'build', endpointCredential: 'credential' }
  }
  const session = {
    targetId: 'source',
    mux: { isDisposed: () => false },
    connection,
    transportGeneration: 2,
    owner: { mode: 'negotiated', ownerLease: 'lease', ownerGeneration: 3 },
    resumed: true
  }
  const owned = { session, dispose: vi.fn(), assertCurrent: vi.fn() }
  mocks.resume.mockResolvedValue(owned)
  const options = {
    targetId: 'source',
    captures: [capture] as unknown as Parameters<
      typeof retainOrcadLiveSuccessorSession
    >[0]['captures'],
    store: {
      getSshTarget: vi.fn(() => ({ ...target })),
      getSshPtyConsumerRecovery: vi.fn(),
      upsertSshPtyConsumerRecovery: vi.fn()
    },
    signal: new AbortController().signal,
    assertAuthority: vi.fn()
  }
  return { connection, manager, capture, session, owned, options, target }
}

it('resumes only the existing connection and disposes only its owned transport', async () => {
  const f = fixture()
  const result = await retainOrcadLiveSuccessorSession(f.options)
  expect(mocks.resume).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: f.connection,
      source: f.capture.source,
      ownerLease: 'lease'
    })
  )
  expect(f.manager.connect).not.toHaveBeenCalled()
  expect(result.readSession()).toBe(f.session)
  await result.dispose()
  expect(f.owned.dispose).toHaveBeenCalledOnce()
  expect(() => result.assertCurrent()).toThrow('disposed')
})

it.each(['endpoint', 'incumbentVersion', 'endpointCredential'] as const)(
  'refuses mixed %s before owner admission',
  async (field) => {
    const f = fixture()
    const second = structuredClone(f.options.captures[0])
    Object.assign(second.source, { [field]: `${second.source[field]}-different` })
    f.options.captures.push(second)
    await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('cohort_mismatch')
    expect(mocks.resume).not.toHaveBeenCalled()
  }
)

it.each(['empty', 'target', 'lease'])('refuses invalid %s cohort', async (kind) => {
  const f = fixture()
  if (kind === 'empty') {
    f.options.captures = []
  }
  if (kind === 'target') {
    f.options.captures[0].sourceSshTargetId = 'other'
  }
  if (kind === 'lease') {
    const second = structuredClone(f.options.captures[0])
    Object.assign(second.identity, { ownerLease: 'other' })
    f.options.captures.push(second)
  }
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('cohort_mismatch')
  expect(mocks.resume).not.toHaveBeenCalled()
})

it('retains the actual existing resumed session without owning its cleanup', async () => {
  const f = fixture()
  const existing = { readSuccessorRetirementSession: () => ({ ...f.session }), dispose: vi.fn() }
  mocks.sessions.set('source', existing)
  const result = await retainOrcadLiveSuccessorSession(f.options)
  expect(result.readSession()).toEqual(f.session)
  expect(mocks.resume).not.toHaveBeenCalled()
  result.dispose()
  expect(existing.dispose).not.toHaveBeenCalled()
})

it('does not replace an existing non-resumed session', async () => {
  const f = fixture()
  mocks.sessions.set('source', { readSuccessorRetirementSession: () => null })
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('session_required')
  expect(mocks.resume).not.toHaveBeenCalled()
})

it.each(['replacement', 'owner', 'generation'])('pins existing session %s', async (kind) => {
  const f = fixture()
  mocks.sessions.set('source', { readSuccessorRetirementSession: () => f.session })
  const result = await retainOrcadLiveSuccessorSession(f.options)
  if (kind === 'replacement') {
    mocks.sessions.set('source', {})
  }
  if (kind === 'owner') {
    f.session.owner.ownerGeneration++
  }
  if (kind === 'generation') {
    f.session.transportGeneration++
  }
  expect(() => result.assertCurrent()).toThrow('session_changed')
})

it.each(['registry', 'connection', 'session', 'authority'])(
  'cleans its late transport when %s changes during resume',
  async (kind) => {
    const f = fixture()
    mocks.resume.mockImplementation(async () => {
      if (kind === 'registry') {
        mocks.manager.mockReturnValue(null)
      }
      if (kind === 'connection') {
        f.manager.getConnection.mockReturnValue({ ...f.connection })
      }
      if (kind === 'session') {
        mocks.sessions.set('source', {})
      }
      if (kind === 'authority') {
        f.options.assertAuthority.mockImplementation(() => {
          throw new Error('revoked')
        })
      }
      return f.owned
    })
    await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow()
    expect(f.owned.dispose).toHaveBeenCalledOnce()
  }
)

it('does not establish a disconnected source connection', async () => {
  const f = fixture()
  f.connection.getState = () => ({ status: 'disconnected' })
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('connection_changed')
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(f.manager.connect).not.toHaveBeenCalled()
  expect(f.manager.connectExclusive).not.toHaveBeenCalled()
})

function freshFixture() {
  const f = fixture()
  const release = vi.fn(async () => {})
  f.manager.getConnection.mockReturnValue(undefined)
  f.manager.connectExclusive.mockImplementation(async (_target, authority) => {
    authority.assertAuthority()
    f.manager.getConnection.mockReturnValue(f.connection)
    return { connection: f.connection, release }
  })
  return { ...f, release }
}

it('establishes an exclusive raw connection and releases it after the owned relay', async () => {
  const f = freshFixture()
  const retained = await retainOrcadLiveSuccessorSession(f.options)
  expect(f.manager.connectExclusive).toHaveBeenCalledWith(
    f.target,
    expect.objectContaining({
      signal: f.options.signal,
      assertAuthority: expect.any(Function)
    })
  )
  expect(f.manager.connect).not.toHaveBeenCalled()
  expect(retained.readSession()).toBe(f.session)
  f.release.mockImplementation(async () => {
    expect(f.owned.dispose).toHaveBeenCalledOnce()
  })
  await retained.dispose()
  expect(f.release).toHaveBeenCalledOnce()
})

it('does not resume after exclusive raw admission fails', async () => {
  const f = freshFixture()
  f.manager.connectExclusive.mockRejectedValue(new Error('admission-failed'))
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('admission-failed')
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(f.release).not.toHaveBeenCalled()
})

it('releases the exclusive raw connection when source resume fails', async () => {
  const f = freshFixture()
  mocks.resume.mockRejectedValue(new Error('resume-failed'))
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('resume-failed')
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.owned.dispose).not.toHaveBeenCalled()
})

it('preserves both resume and exclusive raw cleanup failures', async () => {
  const f = freshFixture()
  const resumeError = new Error('resume-failed')
  const cleanupError = new Error('cleanup-failed')
  mocks.resume.mockRejectedValue(resumeError)
  f.release.mockRejectedValue(cleanupError)
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toMatchObject({
    message: 'orcad_live_successor_connection_cleanup_failed',
    errors: [resumeError, cleanupError]
  })
  expect(f.release).toHaveBeenCalledOnce()
})

it('rejects late target drift and releases newly admitted raw transport before resume', async () => {
  const f = freshFixture()
  f.manager.connectExclusive.mockImplementation(async () => {
    f.manager.getConnection.mockReturnValue(f.connection)
    f.options.store.getSshTarget.mockReturnValue({ ...f.target, host: 'different' })
    return { connection: f.connection, release: f.release }
  })
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('target_changed')
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
})

it('waits for exclusive raw cleanup after disposing the owned relay', async () => {
  const f = freshFixture()
  const retained = await retainOrcadLiveSuccessorSession(f.options)
  const cleanup = Promise.withResolvers<void>()
  f.release.mockReturnValue(cleanup.promise)
  const finished = vi.fn()
  const disposing = Promise.resolve(retained.dispose()).then(finished)
  await Promise.resolve()
  expect(f.owned.dispose).toHaveBeenCalledOnce()
  expect(finished).not.toHaveBeenCalled()
  cleanup.resolve()
  await disposing
  expect(finished).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'still drains exclusive transport after relay disposal throws (drain fails: %s)',
  async (drainFails) => {
    const f = freshFixture()
    const retained = await retainOrcadLiveSuccessorSession(f.options)
    const relayError = new Error('relay-dispose-failed')
    const drainError = new Error('raw-drain-failed')
    f.owned.dispose.mockImplementation(() => {
      throw relayError
    })
    if (drainFails) {
      f.release.mockRejectedValue(drainError)
    }
    const error = await Promise.resolve(retained.dispose()).catch((value: unknown) => value)
    expect(f.release).toHaveBeenCalledOnce()
    expect(error).toEqual(
      drainFails ? expect.objectContaining({ errors: [relayError, drainError] }) : relayError
    )
    await expect(retained.dispose()).rejects.toBe(error)
    expect(f.owned.dispose).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
  }
)

it('preserves admission and both cleanup failures when late source validation fails', async () => {
  const f = freshFixture()
  const admissionError = new Error('admission-failed')
  const relayError = new Error('relay-dispose-failed')
  const drainError = new Error('raw-drain-failed')
  f.owned.assertCurrent.mockImplementation(() => {
    throw admissionError
  })
  f.owned.dispose.mockImplementation(() => {
    throw relayError
  })
  f.release.mockRejectedValue(drainError)
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toMatchObject({
    errors: [admissionError, expect.objectContaining({ errors: [relayError, drainError] })]
  })
  expect(f.release).toHaveBeenCalledOnce()
})

it.each(['host', 'username', 'port', 'generation', 'owner'])(
  'refuses mismatched pooled %s before resuming',
  async (field) => {
    const f = fixture()
    const value = field === 'port' ? 2222 : field === 'generation' ? 2 : 'other'
    f.connection.getTarget.mockReturnValue({ ...f.target, [field]: value })
    await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('target_changed')
    expect(mocks.resume).not.toHaveBeenCalled()
  }
)

it.each(['stored', 'pooled'])(
  'disposes late owned transport after %s target changes',
  async (kind) => {
    const f = fixture()
    mocks.resume.mockImplementation(async () => {
      const changed = { ...f.target, host: 'other' }
      if (kind === 'stored') {
        f.options.store.getSshTarget.mockReturnValue(changed)
      } else {
        f.connection.getTarget.mockReturnValue(changed)
      }
      return f.owned
    })
    await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('target_changed')
    expect(f.owned.dispose).toHaveBeenCalledOnce()
  }
)

it.each(['shutdown', 'reset'] as const)('refuses %s before resuming', async (guard) => {
  const f = fixture()
  mocks[guard].mockImplementation(() => {
    throw new Error('fenced')
  })
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('fenced')
  expect(mocks.resume).not.toHaveBeenCalled()
})

it.each(['shutdown', 'reset'] as const)(
  'cleans owned transport after late %s revocation',
  async (guard) => {
    const f = fixture()
    mocks.resume.mockImplementation(async () => {
      mocks[guard].mockImplementation(() => {
        throw new Error('fenced')
      })
      return f.owned
    })
    await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('fenced')
    expect(f.owned.dispose).toHaveBeenCalledOnce()
  }
)

it.each(['connecting', 'reconnecting', 'resetting', 'testing', 'probes'] as const)(
  'rejects conflicting %s before resume',
  async (activity) => {
    const f = fixture()
    if (activity === 'probes') {
      mocks.probes.mockReturnValue(true)
    } else {
      mocks[activity].add('source')
    }
    await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('activity_changed')
    expect(mocks.resume).not.toHaveBeenCalled()
  }
)

it.each(['authority', 'activity'])('disposes owned transport on late %s conflict', async (kind) => {
  const f = fixture()
  mocks.resume.mockImplementation(async () => {
    if (kind === 'authority') {
      rotateSshProviderAuthority('source')
    } else {
      mocks.connecting.add('source')
    }
    return f.owned
  })
  await expect(retainOrcadLiveSuccessorSession(f.options)).rejects.toThrow('activity_changed')
  expect(f.owned.dispose).toHaveBeenCalledOnce()
})

it('revokes borrowed authority when provider authority rotates', async () => {
  const f = fixture()
  const borrowed = { readSuccessorRetirementSession: () => f.session, dispose: vi.fn() }
  mocks.sessions.set('source', borrowed)
  const retained = await retainOrcadLiveSuccessorSession(f.options)
  rotateSshProviderAuthority('source')
  expect(() => retained.assertCurrent()).toThrow('activity_changed')
  retained.dispose()
  expect(borrowed.dispose).not.toHaveBeenCalled()
})

it.each(['shutdown', 'reset'] as const)(
  'revokes borrowed authority on %s without disposing it',
  async (guard) => {
    const f = fixture()
    const borrowed = { readSuccessorRetirementSession: () => f.session, dispose: vi.fn() }
    mocks.sessions.set('source', borrowed)
    const retained = await retainOrcadLiveSuccessorSession(f.options)
    mocks[guard].mockImplementation(() => {
      throw new Error('fenced')
    })
    expect(() => retained.readSession()).toThrow('fenced')
    expect(() => retained.assertCurrent()).toThrow('fenced')
    retained.dispose()
    expect(borrowed.dispose).not.toHaveBeenCalled()
  }
)
