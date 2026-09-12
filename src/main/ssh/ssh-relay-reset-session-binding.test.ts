import { expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  RELAY_OWNER_RESET_CAPABILITY,
  RELAY_DURABLE_RESET_PREPARATION_CAPABILITY
} from '../../shared/relay-owner-reset-contract'
import {
  captureSshRelayResetSessionBinding,
  sshRelayResetTargetRoutingDigest,
  type SshRelayResetSessionSnapshot
} from './ssh-relay-reset-session-binding'

function fixture() {
  const target: SshTarget = {
    id: 'target',
    generation: 1,
    label: 'host',
    host: 'example.test',
    username: 'user',
    port: 22
  }
  const status = {
    capabilities: [RELAY_OWNER_RESET_CAPABILITY],
    ownerReset: { version: 1, runtimeIncarnation: 'daemon-1' }
  }
  const mux = { request: vi.fn(async () => status), isDisposed: vi.fn(() => false) }
  const session: SshRelayResetSessionSnapshot = {
    connectedTarget: { ...target },
    connection: {},
    transportGeneration: 1,
    mux,
    owner: {
      mode: 'negotiated',
      clientInstanceId: 'desktop',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'lease'
    },
    serverBuildId: 'build',
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/relay/bun',
      runtimeKind: 'bun',
      sockPath: '/relay/socket',
      credentialFile: '/relay/credential',
      relayPlatform: 'linux-x64'
    }
  }
  const options = {
    readTarget: vi.fn(() => target as SshTarget | undefined),
    readSession: vi.fn(() => session as SshRelayResetSessionSnapshot | null)
  }
  return { target, status, mux, session, options }
}

it('captures an immutable initial binding and reuses only the exact retained operation', async () => {
  const f = fixture()
  const binding = await captureSshRelayResetSessionBinding(f.options)
  expect(binding.intent.request.runtimeIncarnation).toBe('daemon-1')
  expect(binding.intent.endpoint.runtimeKind).toBe('bun')
  expect(binding.intent).not.toHaveProperty('destination')
  const retry = await captureSshRelayResetSessionBinding({ ...f.options, existing: binding.intent })
  expect(retry.intent).toEqual(binding.intent)
  binding.assertAuthority()
  expect(f.mux.request.mock.calls).toEqual([['relay.status'], ['relay.status']])
})

it('captures durable recovery coordinates only from a matching authenticated host status', async () => {
  const f = fixture()
  const preparation = {
    version: 1,
    journalDirectory: '/journal',
    principal: 'owner',
    authenticationKind: 'endpoint-credential',
    sockPath: f.session.endpoint.sockPath,
    serverBuildId: f.session.serverBuildId
  }
  f.status.capabilities.push(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY)
  Object.assign(f.status.ownerReset, { preparation })
  const captured = await captureSshRelayResetSessionBinding(f.options)
  expect(captured.intent.preparation).toEqual(preparation)
  expect(Object.isFrozen(captured.intent.preparation)).toBe(true)
  preparation.principal = 'changed'
  await expect(
    captureSshRelayResetSessionBinding({ ...f.options, existing: captured.intent })
  ).rejects.toThrow('intent_binding_changed')
})

it.each(['sockPath', 'serverBuildId'] as const)('refuses mismatched durable %s', async (field) => {
  const f = fixture()
  f.status.capabilities.push(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY)
  Object.assign(f.status.ownerReset, {
    preparation: {
      version: 1,
      journalDirectory: '/journal',
      principal: 'owner',
      authenticationKind: 'endpoint-credential',
      sockPath: f.session.endpoint.sockPath,
      serverBuildId: f.session.serverBuildId,
      [field]: 'other'
    }
  })
  await expect(captureSshRelayResetSessionBinding(f.options)).rejects.toThrow(
    'preparation_binding_changed'
  )
})

it.each(['target', 'session', 'disposed'])(
  'refuses unavailable %s without RPC',
  async (missing) => {
    const f = fixture()
    if (missing === 'target') {
      f.options.readTarget.mockReturnValue(undefined)
    }
    if (missing === 'session') {
      f.options.readSession.mockReturnValue(null)
    }
    if (missing === 'disposed') {
      f.mux.isDisposed.mockReturnValue(true)
    }
    await expect(captureSshRelayResetSessionBinding(f.options)).rejects.toThrow(
      'active_owner_unavailable'
    )
    expect(f.mux.request).not.toHaveBeenCalled()
  }
)

it.each([
  'generation',
  'routing',
  'transport',
  'connection',
  'reconnect',
  'owner',
  'client-generation',
  'endpoint',
  'build'
])('refuses changed %s during negotiation and after capture', async (changed) => {
  const f = fixture()
  const binding = await captureSshRelayResetSessionBinding(f.options)
  const pending = Promise.withResolvers<typeof f.status>()
  f.mux.request.mockReturnValueOnce(pending.promise)
  const second = captureSshRelayResetSessionBinding(f.options)
  if (changed === 'generation') {
    f.target.generation = 2
  }
  if (changed === 'routing') {
    f.target.jumpHost = 'other'
  }
  if (changed === 'transport') {
    f.session.mux = { ...f.mux }
  }
  if (changed === 'connection') {
    f.session.connection = {}
  }
  if (changed === 'reconnect') {
    f.session.transportGeneration!++
  }
  if (changed === 'owner') {
    f.session.owner.ownerLease = 'replacement'
  }
  if (changed === 'client-generation') {
    f.session.owner.clientGeneration++
  }
  if (changed === 'endpoint') {
    f.session.endpoint = { ...f.session.endpoint, sockPath: '/other' }
  }
  if (changed === 'build') {
    f.session.serverBuildId = 'other-build'
  }
  pending.resolve(f.status)
  await expect(second).rejects.toThrow('session_binding_changed')
  expect(() => binding.assertAuthority()).toThrow('session_binding_changed')
})

function destination() {
  return {
    version: 1 as const,
    transport: 'ssh2' as const,
    host: 'resolved.example.test',
    port: 2222,
    username: 'resolved-user',
    hostKeyFingerprint: `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')}`,
    proxyRouteDigest: 'a'.repeat(64)
  }
}

it('persists a canonical immutable destination independently of the mutable snapshot', async () => {
  const f = fixture()
  const resolved = destination()
  f.session.destination = resolved
  const binding = await captureSshRelayResetSessionBinding(f.options)
  expect(binding.intent.destination).toEqual(resolved)
  expect(Object.isFrozen(binding.intent.destination)).toBe(true)
  resolved.host = 'replacement.test'
  expect(binding.intent.destination?.host).toBe('resolved.example.test')
  expect(() => binding.assertAuthority()).toThrow('session_binding_changed')
  await expect(
    captureSshRelayResetSessionBinding({ ...f.options, existing: binding.intent })
  ).rejects.toThrow('intent_binding_changed')
})

it.each(['host', 'port', 'username', 'hostKeyFingerprint', 'proxyRouteDigest', 'missing'])(
  'refuses resolved destination %s drift while status is pending',
  async (field) => {
    const f = fixture()
    f.session.destination = destination()
    const pending = Promise.withResolvers<typeof f.status>()
    f.mux.request.mockReturnValueOnce(pending.promise)
    const capture = captureSshRelayResetSessionBinding(f.options)
    const changed = {
      host: 'replacement.test',
      port: 22,
      username: 'other',
      hostKeyFingerprint: `SHA256:${Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')}`,
      proxyRouteDigest: 'b'.repeat(64)
    }
    f.session.destination =
      field === 'missing'
        ? undefined
        : { ...destination(), [field]: changed[field as keyof typeof changed] }
    pending.resolve(f.status)
    await expect(capture).rejects.toThrow('session_binding_changed')
  }
)

it('does not replace a retained incarnation with fresh status', async () => {
  const f = fixture()
  const binding = await captureSshRelayResetSessionBinding(f.options)
  f.status.ownerReset.runtimeIncarnation = 'daemon-2'
  await expect(
    captureSshRelayResetSessionBinding({ ...f.options, existing: binding.intent })
  ).rejects.toThrow('intent_binding_changed')
})

it('refuses a registry edit that predates capture when the connection still owns the old route', async () => {
  const f = fixture()
  f.target.host = 'replacement.test'
  await expect(captureSshRelayResetSessionBinding(f.options)).rejects.toThrow(
    'session_binding_changed'
  )
  expect(f.mux.request).not.toHaveBeenCalled()
})

it('ignores display metadata but fences every configured routing and authentication input', () => {
  const f = fixture()
  const digest = sshRelayResetTargetRoutingDigest(f.target)
  expect(sshRelayResetTargetRoutingDigest({ ...f.target, label: 'renamed' })).toBe(digest)
  const changes: Partial<SshTarget>[] = [
    { host: 'other' },
    { port: 2222 },
    { username: 'other' },
    { configHost: 'alias' },
    { proxyCommand: 'proxy' },
    { jumpHost: 'jump' },
    { identityFile: 'key' },
    { identityAgent: 'agent' },
    { identitiesOnly: true },
    { gssapiAuthentication: true },
    { systemSshConnectionReuse: false }
  ]
  for (const change of changes) {
    expect(sshRelayResetTargetRoutingDigest({ ...f.target, ...change })).not.toBe(digest)
  }
})
