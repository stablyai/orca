import { afterEach, expect, it, vi } from 'vitest'
import {
  withOutgoingOrcadAuthority,
  withOutgoingOrcadSuccessorAuthority
} from './orcad-outgoing-authority'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { targetLifecycleInFlight } from '../ipc/ssh-target-lifecycle-queue'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { SshTarget } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  environment: vi.fn(),
  readIntent: vi.fn(),
  original: vi.fn(),
  successor: vi.fn(),
  tunnel: vi.fn()
}))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: mocks.environment }))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({ getTarget: mocks.target })
}))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: mocks.tunnel }))
vi.mock('./orcad-live-cutover-intent-store', () => ({
  OrcadLiveCutoverIntentStore: class {
    read = mocks.readIntent
  }
}))
vi.mock('./orcad-live-profile-participation', () => ({
  retainOrcadLiveProfileParticipation: mocks.original
}))
vi.mock('./orcad-live-successor-profile-authority', () => ({
  retainOrcadLiveSuccessorProfileAuthority: mocks.successor
}))

afterEach(() => vi.unstubAllEnvs())

function fixture() {
  vi.resetAllMocks()
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
  const intent = { manifest: { migrationId: 'migration' } }
  const retained = vi.fn()
  mocks.target.mockReturnValue(target)
  mocks.environment.mockReturnValue(environment)
  mocks.readIntent.mockReturnValue(intent)
  mocks.successor.mockReturnValue(retained)
  mocks.original.mockReturnValue(retained)
  mocks.tunnel.mockResolvedValue(undefined)
  const controller = new AbortController()
  const args = {
    binding: {
      version: 1,
      identity,
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1,
      destinationEnvironmentId: 'destination'
    },
    signal: controller.signal,
    assertEvidence: vi.fn(),
    sourceCutoverMigrationId: 'migration'
  }
  return { target, environment, intent, retained, controller, args }
}

it.each(['original', 'successor'] as const)(
  'uses only %s admission and retains both locks',
  async (mode) => {
    const f = fixture()
    const run =
      mode === 'original' ? withOutgoingOrcadAuthority : withOutgoingOrcadSuccessorAuthority
    const selected = mode === 'original' ? mocks.original : mocks.successor
    const other = mode === 'original' ? mocks.successor : mocks.original
    const result = await run('/profile', f.args, async (context) => {
      expect(targetLifecycleInFlight.has('source')).toBe(true)
      expect(targetLifecycleInFlight.has('runtime-ssh-access:/profile:destination')).toBe(true)
      context.assertAuthority()
      expect(f.retained).toHaveBeenCalledTimes(3)
      return 'completed'
    })
    expect(result).toBe('completed')
    expect(selected).toHaveBeenCalledExactlyOnceWith('/profile', f.intent)
    expect(other).not.toHaveBeenCalled()
    expect(mocks.readIntent).toHaveBeenCalledExactlyOnceWith(identity)
  }
)

it.each(['absent', 'wrong', 'missing-migration'] as const)(
  'refuses successor %s intent before opening tunnel or operating',
  async (change) => {
    const f = fixture()
    if (change === 'absent') {
      mocks.readIntent.mockReturnValue(undefined)
    }
    if (change === 'wrong') {
      f.intent.manifest.migrationId = 'other'
    }
    if (change === 'missing-migration') {
      f.args.sourceCutoverMigrationId = ''
    }
    const operation = vi.fn()
    await expect(
      withOutgoingOrcadSuccessorAuthority('/profile', f.args, operation)
    ).rejects.toThrow()
    expect(mocks.tunnel).not.toHaveBeenCalled()
    expect(operation).not.toHaveBeenCalled()
    expect(mocks.original).not.toHaveBeenCalled()
    expect(mocks.successor).not.toHaveBeenCalled()
  }
)

it('refuses lost native successor authority after awaiting tunnel establishment', async () => {
  const f = fixture()
  mocks.tunnel.mockImplementation(async () => {
    await Promise.resolve()
    f.retained.mockImplementation(() => {
      throw new Error('native authority lost')
    })
  })
  const operation = vi.fn()
  await expect(withOutgoingOrcadSuccessorAuthority('/profile', f.args, operation)).rejects.toThrow(
    'native authority lost'
  )
  expect(operation).not.toHaveBeenCalled()
  expect(mocks.successor).toHaveBeenCalledTimes(1)
  expect(mocks.original).not.toHaveBeenCalled()
})

it.each(['target', 'generation', 'environment', 'runtime', 'gate', 'abort'] as const)(
  'refuses %s changes during the tunnel await',
  async (change) => {
    const f = fixture()
    mocks.tunnel.mockImplementation(async () => {
      await Promise.resolve()
      if (change === 'target') {
        f.target.host = 'other'
      }
      if (change === 'generation') {
        f.target.generation!++
      }
      if (change === 'environment') {
        f.environment.pairingRevision++
      }
      if (change === 'runtime') {
        f.environment.runtimeId = 'other'
      }
      if (change === 'gate') {
        vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
      }
      if (change === 'abort') {
        f.controller.abort()
      }
    })
    const operation = vi.fn()
    await expect(
      withOutgoingOrcadSuccessorAuthority('/profile', f.args, operation)
    ).rejects.toThrow()
    expect(operation).not.toHaveBeenCalled()
  }
)

it('does not make a missing intent qualify as successor authority through the ordinary API', async () => {
  const f = fixture()
  mocks.readIntent.mockReturnValue(undefined)
  const operation = vi.fn().mockResolvedValue('ordinary')
  await expect(withOutgoingOrcadAuthority('/profile', f.args, operation)).resolves.toBe('ordinary')
  expect(mocks.successor).not.toHaveBeenCalled()
  expect(mocks.original).not.toHaveBeenCalled()
})
