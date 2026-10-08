import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { ServeReadiness } from '../server/serve-readiness'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { SshTargetOrcadClaims } from './ssh-target-orcad-claims'
import { emptyDependentStateStore } from './ssh-target-orcad-dependents-fixture'

export const MANAGED_VERSION = '0.2.0+abc'
export const MANAGED_PREVIOUS_VERSION = '0.1.0+def'
export const MANAGED_LOCAL_PORT = 46_768

/** A managed server registered in a temp profile, with its claimed SSH target. */
export function createManagedLifecycleHarness() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-managed-lifecycle-'))
  let target: SshTarget = {
    id: 'ssh-1',
    label: 'Builder',
    host: 'builder',
    port: 22,
    username: 'dev',
    generation: 4,
    orcadFence: { environmentId: 'environment-1' }
  }
  const environment = addManagedOrcadEnvironment(userDataPath, {
    id: 'environment-1',
    name: 'Managed',
    pairingCode: encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: `ws://127.0.0.1:${MANAGED_LOCAL_PORT}/`,
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    }),
    orcadDeployment: {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 4,
      localPort: MANAGED_LOCAL_PORT,
      remotePort: 6_768
    }
  })
  const flushes: number[] = []
  const claims = new SshTargetOrcadClaims({
    ...emptyDependentStateStore(),
    allocateSshTargetGeneration: () => 5,
    flushPendingOrThrowAsync: async () => {
      flushes.push(flushes.length)
    },
    getFolderWorkspaces: () => [],
    getRepos: () => [],
    getSshTarget: (id) => (id === target.id ? target : undefined),
    getSshTargets: () => [target],
    updateSshTarget: (_id, updates) => (target = { ...target, ...updates })
  })
  const targetStore = {
    getTarget: (id: string) => (id === target.id ? target : undefined),
    getOrcadRuntimeClaims: () => claims
  }
  const context = (record: Record<string, unknown> = {}) => ({
    activationRecord: {
      active: MANAGED_VERSION,
      previous: MANAGED_PREVIOUS_VERSION,
      activatedAt: '2026-01-01T00:00:00.000Z',
      snapshot: null,
      ...record
    },
    serverTarget: 'linux-x64-glibc',
    connection: {},
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/dev',
    target,
    userDataDir: '/home/dev/.orca'
  })
  return { userDataPath, environment, targetStore, context, flushes, current: () => target }
}

/** Readiness whose pairing offer, once tunneled, matches the harness server's saved one. */
export function managedReadiness(deviceToken = 'device-token'): ServeReadiness {
  const endpoint = 'ws://127.0.0.1:6768'
  return {
    runtimeId: 'runtime-1',
    boundEndpoint: endpoint,
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken,
        publicKeyB64: 'public-key'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    }
  }
}
