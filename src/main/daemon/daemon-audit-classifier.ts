import { lstat } from 'node:fs/promises'
import {
  probeDaemonProcessIdentity,
  type DaemonEvidenceSource,
  type DaemonEvidenceSources,
  type DaemonProcessEvidence,
  type ExactDaemonIncarnation
} from './daemon-incarnation-evidence'
import type {
  DaemonAuditFailureTrigger,
  DaemonAuditGoneReason
} from '../../shared/daemon-audit-eligibility'

export type { DaemonAuditTrigger } from '../../shared/daemon-audit-eligibility'

export type DaemonAuditContext = {
  protocolGeneration: number
  provider: 'local-daemon'
  endpoint: string
  tokenPath: string
  endpointKind: 'unix-socket' | 'windows-named-pipe'
  profileScope: string
}

export type DaemonAuditObservation =
  | {
      state: 'present'
      reason: 'authenticated_inventory'
      trigger: 'inventory_answered'
      evidenceSources: DaemonEvidenceSources
      context: DaemonAuditContext
      exactIncarnation: ExactDaemonIncarnation | null
      reachability: 'authenticated'
      inventoryAuthority: 'authoritative'
      processLiveness: 'unknown'
      processReason: null
      endpointState: DaemonEndpointState
      observedAtMs: number
    }
  | {
      state: 'gone'
      reason: DaemonAuditGoneReason
      trigger: DaemonAuditFailureTrigger
      evidenceSources: DaemonEvidenceSources
      context: DaemonAuditContext
      exactIncarnation: ExactDaemonIncarnation
      reachability: 'authenticated' | 'disconnected' | 'unknown'
      inventoryAuthority: 'unavailable'
      processLiveness: 'gone'
      processReason: DaemonAuditGoneReason
      endpointState: DaemonEndpointState
      observedAtMs: number
    }
  | {
      state: 'unknown'
      reason: DaemonAuditFailureTrigger
      trigger: DaemonAuditFailureTrigger
      evidenceSources: DaemonEvidenceSources
      context: DaemonAuditContext
      exactIncarnation: ExactDaemonIncarnation | null
      reachability: 'authenticated' | 'disconnected' | 'unknown'
      inventoryAuthority: 'unavailable'
      processLiveness: 'present' | 'unknown'
      processReason:
        | Extract<DaemonProcessEvidence, { state: 'present' | 'unknown' }>['reason']
        | null
      endpointState: DaemonEndpointState
      observedAtMs: number
    }

export type DaemonEndpointState = 'missing' | 'named-pipe' | 'non-socket' | 'socket' | 'unknown'

export type DaemonAuditClassifierDependencies = {
  probeProcessIdentity?: typeof probeDaemonProcessIdentity
  inspectEndpointState?: (context: DaemonAuditContext) => Promise<DaemonEndpointState>
}

export type DaemonAuditClassificationOptions = {
  additionalEvidenceSources?: readonly DaemonEvidenceSource[]
  endpointGoneProof?: 'windows_named_pipe_missing'
  dependencies?: DaemonAuditClassifierDependencies
}

export function recordAuthenticatedInventory(
  context: DaemonAuditContext,
  exactIncarnation: ExactDaemonIncarnation | null
): DaemonAuditObservation {
  return {
    state: 'present',
    reason: 'authenticated_inventory',
    trigger: 'inventory_answered',
    evidenceSources: ['authenticated_inventory'],
    context,
    exactIncarnation,
    reachability: 'authenticated',
    inventoryAuthority: 'authoritative',
    processLiveness: 'unknown',
    processReason: null,
    endpointState: context.endpointKind === 'windows-named-pipe' ? 'named-pipe' : 'socket',
    observedAtMs: Date.now()
  }
}

export async function classifyDaemonAuditFailure(
  context: DaemonAuditContext,
  trigger: DaemonAuditFailureTrigger,
  exactIncarnation: ExactDaemonIncarnation | null,
  options: DaemonAuditClassificationOptions = {}
): Promise<DaemonAuditObservation> {
  const probeProcessIdentity =
    options.dependencies?.probeProcessIdentity ?? probeDaemonProcessIdentity
  const inspectEndpoint = options.dependencies?.inspectEndpointState ?? inspectDaemonEndpointState
  const [processEvidence, endpointState] = await Promise.all([
    probeProcessIdentity(exactIncarnation, {
      socketPath: context.endpoint,
      tokenPath: context.tokenPath
    }),
    inspectEndpoint(context)
  ])
  const reachability = reachabilityForTrigger(trigger)
  const evidenceSources = combineEvidenceSources(
    processEvidence.evidenceSources,
    context.endpointKind === 'unix-socket' ? ['endpoint_stat'] : [],
    options.additionalEvidenceSources ?? []
  )
  if (
    options.endpointGoneProof &&
    context.endpointKind === 'windows-named-pipe' &&
    exactIncarnation
  ) {
    return {
      state: 'gone',
      reason: options.endpointGoneProof,
      trigger,
      evidenceSources,
      context,
      exactIncarnation,
      reachability,
      inventoryAuthority: 'unavailable',
      processLiveness: 'gone',
      processReason: options.endpointGoneProof,
      endpointState: 'missing',
      observedAtMs: Date.now()
    }
  }
  if (processEvidence.state === 'gone') {
    return {
      state: 'gone',
      reason: processEvidence.reason,
      trigger,
      evidenceSources,
      context,
      exactIncarnation: processEvidence.exactIncarnation,
      reachability,
      inventoryAuthority: 'unavailable',
      processLiveness: 'gone',
      processReason: processEvidence.reason,
      endpointState,
      observedAtMs: Date.now()
    }
  }
  return {
    state: 'unknown',
    reason: trigger,
    trigger,
    evidenceSources,
    context,
    exactIncarnation,
    reachability,
    inventoryAuthority: 'unavailable',
    processLiveness: processEvidence.state,
    processReason: processEvidence.reason,
    endpointState,
    observedAtMs: Date.now()
  }
}

async function inspectDaemonEndpointState(
  context: DaemonAuditContext
): Promise<DaemonEndpointState> {
  if (context.endpointKind === 'windows-named-pipe') {
    return 'named-pipe'
  }
  try {
    const stats = await lstat(context.endpoint)
    return stats.isSocket() ? 'socket' : 'non-socket'
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? 'missing' : 'unknown'
  }
}

function reachabilityForTrigger(
  trigger: DaemonAuditFailureTrigger
): 'authenticated' | 'disconnected' | 'unknown' {
  if (trigger === 'endpoint_identity_changed') {
    return 'authenticated'
  }
  if (
    trigger === 'transport_closed' ||
    trigger === 'token_missing_after_authenticated_disconnect'
  ) {
    return 'disconnected'
  }
  return 'unknown'
}

function combineEvidenceSources(
  first: DaemonEvidenceSources,
  ...rest: readonly (readonly DaemonEvidenceSource[])[]
): DaemonEvidenceSources {
  return [...new Set([first[0], ...first.slice(1), ...rest.flat()])] as [
    DaemonEvidenceSource,
    ...DaemonEvidenceSource[]
  ]
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
