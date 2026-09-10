import type { DaemonAuditObservation } from '../daemon/daemon-audit-classifier'
import type { DaemonEndpointIdentity } from '../daemon/daemon-hello-protocol'
import { inspectProcessSignal } from '../daemon/daemon-process-inspection'
import type { DaemonGenerationResource } from '../../shared/process-stats-types'

type DaemonSession = { sessionId: string; agentSessionOwners?: readonly unknown[] }

export type DaemonGenerationSource = {
  listSessions(): Promise<DaemonSession[]>
  getLastAuthenticatedDaemonIdentity?(): DaemonEndpointIdentity | null
  getLastAuditObservation?(): DaemonAuditObservation | null
  getConnectedClientCount?(): number
}

export type DaemonGenerationProvider =
  | DaemonGenerationSource
  | {
      getCurrentAdapter(): DaemonGenerationSource
      getAllAdapters(): readonly DaemonGenerationSource[]
    }

export function isDaemonGenerationProvider(value: unknown): value is DaemonGenerationProvider {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if ('listSessions' in value && typeof value.listSessions === 'function') {
    return true
  }
  return (
    'getCurrentAdapter' in value &&
    typeof value.getCurrentAdapter === 'function' &&
    'getAllAdapters' in value &&
    typeof value.getAllAdapters === 'function'
  )
}

type Inspection = ReturnType<typeof inspectProcessSignal>

export async function collectDaemonGenerationInventory(
  provider: DaemonGenerationProvider | null,
  inspect: (pid: number) => Inspection = inspectProcessSignal
): Promise<DaemonGenerationResource[]> {
  if (!provider) {
    return []
  }
  const sources = isGenerationRouter(provider) ? provider.getAllAdapters() : [provider]
  const current = isGenerationRouter(provider) ? provider.getCurrentAdapter() : provider
  return await Promise.all(
    sources.map(async (source, index) =>
      collectGeneration(source, source === current, index, inspect)
    )
  )
}

async function collectGeneration(
  source: DaemonGenerationSource,
  canonical: boolean,
  index: number,
  inspect: (pid: number) => Inspection
): Promise<DaemonGenerationResource> {
  const identity = source.getLastAuthenticatedDaemonIdentity?.() ?? null
  const observation = source.getLastAuditObservation?.() ?? null
  let sessions: DaemonSession[] = []
  let inventoryFailed = false
  try {
    sessions = await source.listSessions()
  } catch {
    inventoryFailed = true
  }
  const processEvidence = identity ? inspect(identity.pid) : 'unavailable'
  const occupied = processEvidence === 'occupied' || processEvidence === 'permission_denied'
  const owned = observation?.state === 'present' && observation.reachability === 'authenticated'
  const unverifiable =
    inventoryFailed ||
    observation === null ||
    observation.state === 'unknown' ||
    processEvidence === 'unavailable'
  const attached = sessions.length > 0
  const generationId = identity
    ? `${identity.pid}:${identity.startedAtMs}:${identity.launchNonce}`
    : `unverifiable:${observation?.context.protocolGeneration ?? 'unknown'}:${index}`
  return {
    generationId,
    protocolGeneration: observation?.context.protocolGeneration ?? null,
    canonical,
    occupied,
    attached,
    owned,
    unverifiable,
    retirementEligible: canRetireDaemonGeneration({
      canonical,
      occupied,
      attached,
      owned,
      unverifiable,
      gone: observation?.state === 'gone'
    }),
    clientCount: connectedClientCount(source),
    sessionIds: sessions.map((session) => session.sessionId),
    processRootPid: identity?.pid ?? null
  }
}

export function canRetireDaemonGeneration(generation: {
  canonical: boolean
  occupied: boolean
  attached: boolean
  owned: boolean
  unverifiable: boolean
  gone: boolean
}): boolean {
  return (
    generation.gone &&
    !generation.canonical &&
    !generation.occupied &&
    !generation.attached &&
    !generation.owned &&
    !generation.unverifiable
  )
}

function connectedClientCount(source: DaemonGenerationSource): number | null {
  const count = source.getConnectedClientCount?.()
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null
}

function isGenerationRouter(
  provider: DaemonGenerationProvider
): provider is Extract<DaemonGenerationProvider, { getAllAdapters(): unknown }> {
  return 'getAllAdapters' in provider && 'getCurrentAdapter' in provider
}
