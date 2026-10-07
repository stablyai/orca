import { vi } from 'vitest'
import type { HostServerOnConnectDeps } from './ssh-host-server-on-connect'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the orchestrator reads only the environment id.
const environment = { id: 'env-1' } as never

/** Every connect collaborator as a stub; tests override only what they exercise. */
export function hostServerDepsStub(
  overrides: Partial<HostServerOnConnectDeps> = {}
): HostServerOnConnectDeps {
  return {
    managedEnvironmentId: () => null,
    ensureTunnel: vi.fn(async () => undefined),
    ensureServing: vi.fn(async () => ({ state: 'serving' as const })),
    retainCommittedSource: vi.fn(),
    hasUnfinishedConversion: () => false,
    abandonConversion: vi.fn(async () => undefined),
    abandonDeploy: vi.fn(async () => undefined),
    hasTemplate: () => true,
    recordedUnavailable: () => null,
    recordUnavailable: vi.fn(),
    isEmptyHost: () => false,
    relayTerminals: vi.fn(async () => ({ verdict: 'exited' as const, count: 0 })),
    deploy: vi.fn(async () => ({ outcome: 'created' as const, environment, activeVersion: '1' })),
    convert: vi.fn(async () => ({ outcome: 'converted' as const, environment, migrationId: 'm' })),
    progress: vi.fn(),
    isFencedBeforeStaging: () => false,
    releaseUnreachableSetup: vi.fn(async () => undefined),
    report: vi.fn(),
    autoUpdate: vi.fn(async () => ({ outcome: 'skipped' as const, reason: 'current' as const })),
    recordedUpdateFailure: () => null,
    recordUpdateFailure: vi.fn(),
    clearUpdateFailure: vi.fn(),
    ...overrides
  }
}
