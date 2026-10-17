import { createHash } from 'node:crypto'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type {
  KnownRuntimeEnvironment,
  RuntimeEnvironmentPreviousPairing
} from '../../shared/runtime-environments'

export type PairedRuntimeHostKind = 'manual' | 'plain-ssh' | 'managed-ssh' | 'wsl'

export type PairedRuntimeHostEnvironmentOptions = {
  kind: PairedRuntimeHostKind
  id?: string
  pairingRevision?: number
  pairedDeviceId?: string
  publicKeyB64?: string
  /** WSL only; null models a record written before the registration GUID was captured. */
  distroId?: string | null
  previousPairing?: RuntimeEnvironmentPreviousPairing
}

export const WSL_DISTRO_ID_A = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
export const WSL_DISTRO_ID_B = '1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d'

/** A runtime environment as each host kind persists it, re-paired by changing revision/device. */
export function pairedRuntimeHostEnvironment(
  options: PairedRuntimeHostEnvironmentOptions
): KnownRuntimeEnvironment {
  const port = 41_001
  const base: KnownRuntimeEnvironment = {
    id: options.id ?? `environment-${options.kind}`,
    name: `Host ${options.kind}`,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastUsedAt: null,
    runtimeId: null,
    pairingRevision: options.pairingRevision ?? 1_000,
    ...(options.pairedDeviceId === undefined ? {} : { pairedDeviceId: options.pairedDeviceId }),
    ...(options.previousPairing === undefined ? {} : { previousPairing: options.previousPairing }),
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        kind: 'websocket',
        label: 'Host',
        endpoint: `ws://127.0.0.1:${port}`,
        deviceToken: `token-${options.pairedDeviceId ?? 'none'}`,
        publicKeyB64: options.publicKeyB64 ?? 'host-key-a'
      }
    ]
  }
  switch (options.kind) {
    case 'manual':
      return base
    case 'plain-ssh':
      return {
        ...base,
        connectionDependency: 'ssh-tunnel',
        sshAccess: {
          sshTargetId: 'target-a',
          sshTargetGeneration: 1,
          localPort: port,
          remotePort: 6768,
          endpointId: 'endpoint-a',
          previousPreferredEndpointId: 'endpoint-direct'
        }
      }
    case 'managed-ssh':
      return {
        ...base,
        connectionDependency: 'ssh-tunnel',
        orcadDeployment: {
          sshTargetId: 'target-a',
          sshTargetGeneration: 1,
          localPort: port,
          remotePort: 6768
        }
      }
    case 'wsl': {
      const distroId = options.distroId === undefined ? WSL_DISTRO_ID_A : options.distroId
      return {
        ...base,
        orcadDeployment: {
          kind: 'wsl',
          distro: 'Ubuntu',
          ...(distroId === null ? {} : { distroId }),
          localPort: port,
          remotePort: 6768
        }
      }
    }
  }
}

/**
 * The authority identity every build before W1 derived, copied verbatim so tests can prove
 * hosts that never rotate keep their exact partition.
 */
export function preW1AuthorityConnectionIdentity(
  orcaProfileId: string,
  environment: KnownRuntimeEnvironment,
  connection: PairedRuntimeConnection
): string {
  const components = [
    'paired-runtime-browser',
    orcaProfileId,
    environment.id,
    environment.pairingRevision ?? environment.createdAt,
    connection.hostPublicKeyB64,
    connection.pairedDeviceId ?? null
  ]
  return `paired-runtime:${createHash('sha256').update(JSON.stringify(components)).digest('hex')}`
}
