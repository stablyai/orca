import { afterEach, expect, it, vi } from 'vitest'
import { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { createManagedOrcadSshOwner } from '../../shared/managed-orcad-ssh-owner'
import { targetLifecycleInFlight } from '../ipc/ssh-target-lifecycle-queue'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { SshTarget } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => ({ target: vi.fn(), environment: vi.fn(), inspect: vi.fn() }))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: mocks.environment }))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({
    getTarget: mocks.target,
    getOrcadMigrationStore: () => ({ listOrcadMigrationSourceCutovers: () => [] })
  })
}))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: async () => {} }))
vi.mock('./orcad-live-cutover-recovery-inspection', () => ({
  inspectOrcadLiveCutoverRecovery: mocks.inspect
}))
afterEach(() => vi.unstubAllEnvs())
function fixture() {
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  const target: SshTarget = {
    id: 'source',
    generation: 1,
    label: 'Source',
    host: 'host',
    port: 22,
    username: 'user'
  }
  const environment = {
    id: 'destination',
    runtimeId: identity.destinationRuntimeId,
    createdAt: 1,
    pairingRevision: 1,
    endpoints: [
      { id: 'endpoint', endpoint: 'ws://host:1234', deviceToken: 'token', publicKeyB64: 'key' }
    ],
    preferredEndpointId: 'endpoint'
  }
  mocks.target.mockReturnValue(target)
  mocks.environment.mockReturnValue(environment)
  const candidate = {
    journal: { phase: 'source-fenced' },
    intent: {
      destinationEnvironmentId: 'destination',
      manifest: {
        migrationId: 'migration',
        source: { sshTargetId: 'source', sshTargetGeneration: 1 }
      },
      liveTerminalBindings: [{ identity }]
    }
  }
  mocks.inspect.mockReturnValue([candidate])
  const args = {
    binding: {
      version: 1,
      identity,
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1,
      destinationEnvironmentId: 'destination'
    },
    signal: new AbortController().signal,
    assertEvidence: vi.fn(),
    sourceCutoverMigrationId: 'migration'
  }
  return { target, environment, candidate, args }
}

it('re-pins only the intentional fence while preserving existing closures and both locks', async () => {
  const f = fixture()
  await withOutgoingOrcadAuthority('/profile', f.args, async (context) => {
    expect(targetLifecycleInFlight.has('source')).toBe(true)
    expect(targetLifecycleInFlight.has('runtime-ssh-access:/profile:destination')).toBe(true)
    context.assertSourceCutoverOwner('unowned')
    const capturedAssert = context.assertAuthority
    f.target.owner = createManagedOrcadSshOwner('destination')
    expect(capturedAssert).toThrow('authority_changed')
    context.assertSourceCutoverOwner('fenced')
    expect(capturedAssert).not.toThrow()
    expect(() => context.assertSourceCutoverOwner('unowned')).toThrow('transition_conflict')
  })
})

it.each(['missing-journal', 'identity', 'host', 'environment', 'generation', 'disabled'] as const)(
  'refuses %s without accepting the new owner',
  async (change) => {
    const f = fixture()
    if (change === 'disabled') {
      Reflect.deleteProperty(f.args, 'sourceCutoverMigrationId')
    }
    await withOutgoingOrcadAuthority('/profile', f.args, async (context) => {
      f.target.owner = createManagedOrcadSshOwner('destination')
      if (change === 'missing-journal') {
        Reflect.deleteProperty(f.candidate, 'journal')
      }
      if (change === 'identity') {
        f.candidate.intent.liveTerminalBindings = [
          { identity: { ...identity, ownerLease: 'other' } }
        ]
      }
      if (change === 'host') {
        f.target.host = 'other'
      }
      if (change === 'environment') {
        f.environment.pairingRevision++
      }
      if (change === 'generation') {
        f.target.generation!++
      }
      expect(() => context.assertSourceCutoverOwner('fenced')).toThrow()
      expect(context.assertAuthority).toThrow('authority_changed')
    })
  }
)
