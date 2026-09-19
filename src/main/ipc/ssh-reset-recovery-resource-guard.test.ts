import { beforeEach, expect, it, vi } from 'vitest'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'
import { sshRelayResetTargetRoutingDigest } from '../ssh/ssh-relay-reset-session-binding'
import { captureSshResetRecoveryResourceGuard } from './ssh-reset-recovery-resource-guard'
import { runSshProviderContinuation } from '../ssh/ssh-provider-continuations'
import { retainSshBrowserRoute } from '../browser/ssh-browser-route-lifetimes'

const f = vi.hoisted(() => ({
  profile: '/profile',
  profileIdentity: vi.fn(),
  registry: { getTarget: vi.fn() } as { getTarget: ReturnType<typeof vi.fn> } | undefined,
  connections: { hasTargetActivity: vi.fn() } as
    | { hasTargetActivity: ReturnType<typeof vi.fn> }
    | undefined,
  forwards: { assertTargetResourcesAbsent: vi.fn() } as
    | { assertTargetResourcesAbsent: ReturnType<typeof vi.fn> }
    | undefined,
  leases: {} as object | undefined,
  sessions: new Map(),
  connects: new Map(),
  resets: new Map(),
  reconnects: new Map(),
  testing: new Set(),
  generations: new Map(),
  probes: vi.fn(),
  pty: vi.fn(),
  filesystem: vi.fn(),
  git: vi.fn(),
  reserved: vi.fn(),
  shutdown: vi.fn(),
  eligible: vi.fn()
}))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => f.profile
}))
vi.mock('../ssh/ssh-reset-profile-identity', () => ({
  captureSshResetProfileIdentity: (profile: string) => ({
    physicalPath: profile,
    assertCurrent: f.profileIdentity
  })
}))
vi.mock('../ssh/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => f.registry }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({ getSshFilesystemProvider: f.filesystem }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: f.git }))
vi.mock('./pty/provider/registry', () => ({
  getSshPtyProvider: f.pty,
  sshProvidersByGeneration: f.generations
}))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: f.sessions }))
vi.mock('./ssh-connect-attempt-registry', () => ({
  assertSshConnectsNotFenced: f.shutdown,
  connectInFlight: f.connects,
  resetRelayInFlight: f.resets,
  pendingTransportReconnects: f.reconnects,
  hasSshTestConnectionProbes: f.probes,
  testingTargets: f.testing
}))
vi.mock('./ssh-ipc-context', () => ({
  get connectionManager() {
    return f.connections
  },
  get portForwardManager() {
    return f.forwards
  },
  get persistedStore() {
    return f.leases
  }
}))
vi.mock('./ssh-target-destruction-admission', () => ({
  assertSshTargetNotManagedOrPreparing: f.eligible
}))

function fixture() {
  const target = {
    id: 'target',
    generation: 1,
    label: 'host',
    host: 'example.test',
    port: 22,
    username: 'owner'
  }
  f.registry!.getTarget.mockReturnValue(target)
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
      operationId: 'reset',
      runtimeIncarnation: 'runtime',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  const selection = {
    version: 1 as const,
    intentSha256: sshRelayResetRecordDigest(intent),
    clientIncarnation: 'previous-client',
    retiredAt: 1,
    leases: [],
    routes: [
      { appPtyId: 'ssh:target@@pty-1', incarnationId: 'pty-incarnation', providerGeneration: 7 }
    ]
  }
  const capture = () =>
    captureSshResetRecoveryResourceGuard({ intent, selection, assertReserved: f.reserved })
  return { target, intent, selection, capture }
}

beforeEach(() => {
  vi.resetAllMocks()
  f.profile = '/profile'
  f.registry = { getTarget: vi.fn() }
  f.connections = { hasTargetActivity: vi.fn(() => false) }
  f.forwards = { assertTargetResourcesAbsent: vi.fn() }
  f.leases = {}
  for (const collection of [
    f.sessions,
    f.connects,
    f.resets,
    f.reconnects,
    f.testing,
    f.generations
  ]) {
    collection.clear()
  }
})

it('refuses still-running provider work after its provider registration disappears', async () => {
  const { capture } = fixture()
  const guard = capture()
  const work = Promise.withResolvers<void>()
  const pending = runSshProviderContinuation('target', () => work.promise)
  expect(capture).toThrow('provider_work_pending')
  expect(guard.assertCurrent).toThrow('provider_work_pending')
  work.resolve()
  await pending
  guard.assertCurrent()
})

it('refuses an overlapping reset even after its session is removed', () => {
  const { capture } = fixture()
  f.resets.set('target', Promise.resolve())
  expect(capture).toThrow('reset_operation_changed')
})

it('retains captured context when initial absence validation is deferred', () => {
  const { intent, selection } = fixture()
  f.sessions.set('target', {})
  const guard = captureSshResetRecoveryResourceGuard({
    intent,
    selection,
    assertReserved: f.reserved,
    deferInitialAssertion: true
  })
  expect(guard.assertCurrent).toThrow('resources_still_retained')
  f.sessions.clear()
  f.connections = { hasTargetActivity: vi.fn(() => false) }
  expect(guard.assertCurrent).toThrow('context_changed')
})

it('accepts only the retained coordinator promise when its retry token changes', () => {
  const { intent, selection } = fixture()
  let expected = Promise.resolve()
  f.resets.set('target', expected)
  const guard = captureSshResetRecoveryResourceGuard({
    intent,
    selection,
    assertReserved: f.reserved,
    expectedReset: () => expected
  })
  expected = Promise.resolve()
  expect(guard.assertCurrent).toThrow('reset_operation_changed')
  f.resets.set('target', expected)
  guard.assertCurrent()
  f.resets.set('target', Promise.resolve())
  expect(guard.assertCurrent).toThrow('reset_operation_changed')
})

it.each(['removed', 'replaced'])('requires the exact published recovery reset: %s', (change) => {
  const { intent, selection } = fixture()
  const expectedReset = Promise.resolve()
  f.resets.set('target', expectedReset)
  const guard = captureSshResetRecoveryResourceGuard({
    intent,
    selection,
    assertReserved: f.reserved,
    expectedReset
  })
  guard.assertCurrent()
  if (change === 'removed') {
    f.resets.delete('target')
  } else {
    f.resets.set('target', Promise.resolve())
  }
  expect(guard.assertCurrent).toThrow('reset_operation_changed')
})

it('captures absent resources and rechecks without mutating the lease store', () => {
  const { capture } = fixture()
  const guard = capture()
  expect(guard.leases).toBe(f.leases)
  guard.assertCurrent()
  expect(f.forwards!.assertTargetResourcesAbsent.mock.calls).toEqual([['target'], ['target']])
  expect(f.reserved).toHaveBeenCalledTimes(4)
  expect(f.connections!.hasTargetActivity).toHaveBeenCalledWith('target')
  expect(f.probes).toHaveBeenCalledWith('target')
})

it('revalidates physical profile identity before and after every forward inspection', () => {
  const { capture } = fixture()
  const checks: string[] = []
  f.profileIdentity.mockImplementation(() => checks.push('identity'))
  f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => checks.push('forwards'))
  const guard = capture()
  guard.assertCurrent()
  expect(checks).toEqual(['identity', 'forwards', 'identity', 'identity', 'forwards', 'identity'])
})

it.each(['before', 'during'] as const)(
  'refuses physical profile identity drift %s forward inspection with unchanged configured path',
  (when) => {
    const { capture } = fixture()
    const guard = capture()
    const refuse = () => {
      throw new Error('ssh_reset_profile_identity_changed')
    }
    const arm = () => {
      f.profileIdentity.mockReset()
      f.forwards!.assertTargetResourcesAbsent.mockReset()
      if (when === 'before') {
        f.profileIdentity.mockImplementation(refuse)
      } else {
        f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => {
          f.profileIdentity.mockImplementation(refuse)
        })
      }
    }
    for (const check of [capture, guard.assertCurrent]) {
      arm()
      expect(check).toThrow('ssh_reset_profile_identity_changed')
      expect(f.profile).toBe('/profile')
      expect(f.forwards!.assertTargetResourcesAbsent).toHaveBeenCalledTimes(
        when === 'before' ? 0 : 1
      )
    }
  }
)

it.each(['registry', 'connections', 'forwards', 'leases'] as const)('refuses missing %s', (key) => {
  const { capture } = fixture()
  f[key] = undefined
  expect(capture).toThrow('resources_unavailable')
})

it.each(['registry', 'connections', 'forwards', 'leases', 'profile'] as const)(
  'refuses replaced %s after capture',
  (key) => {
    const { capture } = fixture()
    const guard = capture()
    if (key === 'profile') {
      f.profile = '/other-profile'
    } else if (key === 'registry') {
      f.registry = { getTarget: vi.fn() }
    } else if (key === 'connections') {
      f.connections = { hasTargetActivity: vi.fn() }
    } else if (key === 'forwards') {
      f.forwards = { assertTargetResourcesAbsent: vi.fn() }
    } else {
      f.leases = {}
    }
    expect(guard.assertCurrent).toThrow('context_changed')
  }
)

it.each(['missing', 'id', 'generation', 'host', 'username', 'port'] as const)(
  'refuses target %s drift',
  (field) => {
    const { capture, target } = fixture()
    const guard = capture()
    f.registry!.getTarget.mockReturnValue(
      field === 'missing'
        ? undefined
        : {
            ...target,
            [field]: field === 'generation' || field === 'port' ? 2 : 'other'
          }
    )
    expect(guard.assertCurrent).toThrow('target_changed')
  }
)

const resourceCases = [
  ['session', () => f.sessions.set('target', {})],
  ['manager activity', () => f.connections!.hasTargetActivity.mockReturnValue(true)],
  ['pending connect', () => f.connects.set('target', Promise.resolve())],
  ['pending reconnect', () => f.reconnects.set('target', {})],
  ['probe', () => f.probes.mockReturnValue(true)],
  ['testing UI flag', () => f.testing.add('target')],
  ['PTY provider', () => f.pty.mockReturnValue({})],
  ['filesystem provider', () => f.filesystem.mockReturnValue({})],
  ['Git provider', () => f.git.mockReturnValue({})],
  ['selected provider generation', () => f.generations.set(7, {})]
] as const

it.each(resourceCases)('refuses retained %s at capture and recheck', (_name, arrive) => {
  const { capture } = fixture()
  const guard = capture()
  arrive()
  expect(capture).toThrow('resources_still_retained')
  expect(guard.assertCurrent).toThrow('resources_still_retained')
})

it.each(resourceCases)('refuses %s arriving inside the forward check', (_name, arrive) => {
  const { capture } = fixture()
  f.forwards!.assertTargetResourcesAbsent.mockImplementation(arrive)
  expect(capture).toThrow('resources_still_retained')
})

it('propagates forward uncertainty without accepting resource absence', () => {
  const { capture } = fixture()
  f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => {
    throw new Error('forward retained')
  })
  expect(capture).toThrow('forward retained')
})

it('does not block on unrelated target registrations or provider generations', () => {
  const { capture } = fixture()
  f.sessions.set('other', {})
  f.connects.set('other', Promise.resolve())
  f.reconnects.set('other', {})
  f.testing.add('other')
  f.generations.set(8, {})
  expect(capture).not.toThrow()
})

it.each(['profile', 'target'] as const)('refuses %s drift inside the forward check', (kind) => {
  const { capture, target } = fixture()
  f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => {
    if (kind === 'profile') {
      f.profile = '/other'
    } else {
      f.registry!.getTarget.mockReturnValue({ ...target, host: 'changed.test' })
    }
  })
  expect(capture).toThrow(kind === 'profile' ? 'context_changed' : 'target_changed')
})

it.each(['reserved', 'shutdown', 'eligible'] as const)(
  'refuses %s before and during the forward check',
  (key) => {
    const { capture } = fixture()
    const refuse = () => {
      throw new Error(`${key} refused`)
    }
    f[key].mockImplementation(refuse)
    expect(capture).toThrow(`${key} refused`)
    f[key].mockReset()
    f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => {
      f[key].mockImplementation(refuse)
    })
    expect(capture).toThrow(`${key} refused`)
  }
)

it('rejects invalid selection before consulting resource registries', () => {
  const { intent, selection } = fixture()
  expect(() =>
    captureSshResetRecoveryResourceGuard({
      intent,
      selection: { ...selection, intentSha256: 'wrong' },
      assertReserved: f.reserved
    })
  ).toThrow('selection_invalid')
  expect(f.reserved).not.toHaveBeenCalled()
})

it('refuses browser lifetime after other registries disappear and rechecks after forward inspection', async () => {
  const { capture, intent } = fixture()
  const closed = Promise.withResolvers<void>()
  const open = () =>
    retainSshBrowserRoute(intent.targetId, async (allocation) => {
      allocation.started = true
      return {
        key: 'browser',
        isValid: () => false,
        connect: () => {
          throw new Error('unused')
        },
        close: () => closed.promise
      }
    })
  const route = await open()
  expect(capture).toThrow('not_drained')
  const closing = route.close()
  expect(capture).toThrow('not_drained')
  closed.resolve()
  await closing
  expect(capture).not.toThrow()
  let arriving: ReturnType<typeof open> | undefined
  f.forwards!.assertTargetResourcesAbsent.mockImplementation(() => {
    arriving = open()
  })
  expect(capture).toThrow('not_drained')
  await (await arriving!).close()
})
