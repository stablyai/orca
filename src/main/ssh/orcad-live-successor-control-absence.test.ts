import { beforeEach, expect, it, vi } from 'vitest'
import { bindOrcadLiveSuccessorControlAbsence } from './orcad-live-successor-control-absence'

const f = vi.hoisted(() => ({
  manager: undefined as
    | undefined
    | {
        assertTargetTransportsClosed: ReturnType<typeof vi.fn>
        hasTargetActivity: ReturnType<typeof vi.fn>
      },
  forwards: undefined as undefined | { assertTargetResourcesAbsent: ReturnType<typeof vi.fn> },
  generation: 1,
  sessions: new Map(),
  connects: new Map(),
  reconnects: new Map(),
  resets: new Map(),
  testing: new Set(),
  generations: new Map(),
  probes: vi.fn(),
  continuations: vi.fn(),
  browser: vi.fn(),
  pty: vi.fn(),
  filesystem: vi.fn(),
  git: vi.fn(),
  native: vi.fn(),
  shutdown: vi.fn(),
  reset: vi.fn()
}))
vi.mock('./ssh-target-registry', () => ({ getSshConnectionManager: () => f.manager }))
vi.mock('./ssh-provider-authority', () => ({
  getSshProviderAuthority: (targetId: string) => ({
    targetId,
    connectionGeneration: f.generation,
    providerEpoch: 'epoch'
  }),
  isCurrentSshProviderAuthority: (authority: { connectionGeneration: number }) =>
    authority.connectionGeneration === f.generation
}))
vi.mock('./ssh-provider-continuations', () => ({ hasSshProviderContinuations: f.continuations }))
vi.mock('../browser/ssh-browser-route-lifetimes', () => ({
  assertSshBrowserResourcesAbsent: f.browser
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({ getSshFilesystemProvider: f.filesystem }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: f.git }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: f.pty,
  sshProvidersByGeneration: f.generations
}))
vi.mock('../ipc/ssh-active-relay-sessions', () => ({ activeSessions: f.sessions }))
vi.mock('../ipc/ssh-ipc-context', () => ({
  get portForwardManager() {
    return f.forwards
  }
}))
vi.mock('../ipc/ssh-reset-production-state', () => ({ assertSshResetAdmissionAllowed: f.reset }))
vi.mock('../ipc/ssh-connect-attempt-registry', () => ({
  assertSshConnectsNotFenced: f.shutdown,
  connectInFlight: f.connects,
  pendingTransportReconnects: f.reconnects,
  resetRelayInFlight: f.resets,
  hasSshTestConnectionProbes: f.probes,
  testingTargets: f.testing
}))
beforeEach(() => {
  vi.resetAllMocks()
  for (const collection of [
    f.sessions,
    f.connects,
    f.reconnects,
    f.resets,
    f.testing,
    f.generations
  ]) {
    collection.clear()
  }
  f.generation = 1
  f.manager = { assertTargetTransportsClosed: vi.fn(), hasTargetActivity: vi.fn(() => false) }
  f.forwards = { assertTargetResourcesAbsent: vi.fn() }
})
const bind = (signal = new AbortController().signal) =>
  bindOrcadLiveSuccessorControlAbsence({ targetId: 'target', signal, assertAuthority: f.native })

it('binds current absence without disposing or starting any resource', () => {
  const guard = bind()
  guard.assertAbsent()
  expect(f.manager!.assertTargetTransportsClosed.mock.calls).toEqual(
    Array.from({ length: 4 }, () => ['target'])
  )
  expect(f.forwards!.assertTargetResourcesAbsent.mock.calls).toEqual([['target'], ['target']])
})

it.each(['sessions', 'connects', 'reconnects', 'resets', 'testing'] as const)(
  'refuses retained %s',
  (name) => {
    const collection = f[name]
    if (collection instanceof Set) {
      collection.add('target')
    } else {
      collection.set('target', {})
    }
    expect(() => bind()).toThrow('controls_retained')
  }
)

it.each(['probes', 'continuations', 'pty', 'filesystem', 'git'] as const)(
  'refuses retained %s',
  (name) => {
    f[name].mockReturnValue(true)
    expect(() => bind()).toThrow('controls_retained')
  }
)

it.each(['native', 'shutdown', 'reset', 'browser'] as const)(
  'propagates failed %s proof',
  (name) => {
    f[name].mockImplementation(() => {
      throw new Error('proof_failed')
    })
    expect(() => bind()).toThrow('proof_failed')
  }
)

it('requires positive transport and port-forward resource absence', () => {
  f.manager!.assertTargetTransportsClosed.mockImplementationOnce(() => {
    throw new Error('transport_open')
  })
  expect(() => bind()).toThrow('transport_open')
  f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => {
    throw new Error('forward_open')
  })
  expect(() => bind()).toThrow('forward_open')
})

it.each([
  {},
  { getConnectionId: () => null },
  { getConnectionId: () => '' },
  { getConnectionId: () => 'target' }
])('refuses retained or unknown generation-index provider ownership %j', (provider) => {
  f.generations.set(10, provider)
  expect(() => bind()).toThrow('retained_provider')
})

it('allows known other-target providers but does not query their remote sessions', () => {
  const provider = { getConnectionId: vi.fn(() => 'other'), listSessions: vi.fn() }
  f.generations.set(1, provider)
  f.generations.set(2, provider)
  bind()
  expect(provider.getConnectionId).toHaveBeenCalledTimes(2)
  expect(provider.listSessions).not.toHaveBeenCalled()
})

it.each(['manager', 'forwards', 'generation'] as const)(
  'rejects captured %s replacement',
  (kind) => {
    const guard = bind()
    if (kind === 'manager') {
      f.manager = { ...f.manager! }
    }
    if (kind === 'forwards') {
      f.forwards = { ...f.forwards! }
    }
    if (kind === 'generation') {
      f.generation++
    }
    expect(() => guard.assertAbsent()).toThrow('context_changed')
  }
)

it.each(['manager', 'forwards'] as const)('refuses absent %s wiring', (kind) => {
  f[kind] = undefined
  expect(() => bind()).toThrow('context_unavailable')
})

it('rechecks registries and authority after port-forward inspection', () => {
  const guard = bind()
  f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => {
    f.sessions.set('target', {})
  })
  expect(() => guard.assertAbsent()).toThrow('controls_retained')
  f.sessions.clear()
  f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => {
    f.generation++
  })
  expect(() => guard.assertAbsent()).toThrow('context_changed')
})

it('pins cancellation and caller authority for later assertions', () => {
  const controller = new AbortController()
  const guard = bind(controller.signal)
  controller.abort()
  expect(() => guard.assertAbsent()).toThrow()
  expect(() => bind(AbortSignal.abort())).toThrow()
})
