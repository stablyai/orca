import type { HostProfile } from './types'

const pendingByHost = new Map<string, Promise<void>>()
const revisionByHost = new Map<string, number>()
const retirementRevisionByHost = new Map<string, number>()
const endpointRevisionByHost = new Map<string, number>()
const endpointGenerationByHost = new Map<string, number>()
const publishedIdentityByHost = new Map<string, Pick<HostProfile, 'deviceToken' | 'publicKeyB64'>>()

export type HostEndpointPublicationLifecycle = Readonly<{
  generation: number
  endpointRevision: number
}>

export function getHostProfilePublicationRevision(hostId: string): number {
  return revisionByHost.get(hostId) ?? 0
}

export function recordHostProfileMutation(hostId: string): void {
  revisionByHost.set(hostId, getHostProfilePublicationRevision(hostId) + 1)
}

export function recordHostEndpointMutation(hostId: string): void {
  recordHostProfileMutation(hostId)
  advanceHostEndpointRevision(hostId)
}

export function getPublishedHostIdentity(
  hostId: string
): Pick<HostProfile, 'deviceToken' | 'publicKeyB64'> | undefined {
  return publishedIdentityByHost.get(hostId)
}

export function recordDurableHostIdentity(
  host: Pick<HostProfile, 'id' | 'deviceToken' | 'publicKeyB64'>
): void {
  publishedIdentityByHost.set(host.id, {
    deviceToken: host.deviceToken,
    publicKeyB64: host.publicKeyB64
  })
}

export function retireHostProfilePublication(hostId: string): Promise<void> | null {
  retirementRevisionByHost.set(hostId, getRetirementRevision(hostId) + 1)
  recordHostEndpointMutation(hostId)
  endpointGenerationByHost.set(hostId, (endpointGenerationByHost.get(hostId) ?? 0) + 1)
  publishedIdentityByHost.delete(hostId)
  const pending = pendingByHost.get(hostId) ?? null
  pendingByHost.delete(hostId)
  return pending
}

export function beginHostEndpointPublicationLifecycle(
  hostId: string
): HostEndpointPublicationLifecycle {
  const generation = (endpointGenerationByHost.get(hostId) ?? 0) + 1
  endpointGenerationByHost.set(hostId, generation)
  return {
    generation,
    endpointRevision: getHostEndpointRevision(hostId)
  }
}

export function getHostEndpointPublicationLifecycle(
  hostId: string
): HostEndpointPublicationLifecycle {
  return {
    generation: endpointGenerationByHost.get(hostId) ?? 0,
    endpointRevision: getHostEndpointRevision(hostId)
  }
}

export function serializeHostProfilePublication<T>(
  hostId: string,
  publish: () => Promise<T>
): Promise<T> {
  const previous = pendingByHost.get(hostId) ?? Promise.resolve()
  const result = previous.then(publish)
  const settled = result.then(
    () => undefined,
    () => undefined
  )
  pendingByHost.set(hostId, settled)
  void settled.then(() => {
    if (pendingByHost.get(hostId) === settled) {
      pendingByHost.delete(hostId)
    }
  })
  return result
}

export function publishHostProfileTransaction(
  host: HostProfile,
  beforeHostSave: (() => Promise<void>) | null,
  saveHost: (host: HostProfile) => Promise<void>,
  requestedRevision: number | 'adopt-current' = getHostProfilePublicationRevision(host.id)
): Promise<void> {
  const retirementRevision = getRetirementRevision(host.id)
  return serializeHostProfilePublication(host.id, async () => {
    requireRetirementRevision(host.id, retirementRevision)
    const publicationRevision =
      requestedRevision === 'adopt-current'
        ? getHostProfilePublicationRevision(host.id)
        : requestedRevision
    requirePublicationRevision(host.id, publicationRevision)
    await beforeHostSave?.()
    requireRetirementRevision(host.id, retirementRevision)
    requirePublicationRevision(host.id, publicationRevision)
    await saveHost(host)
    requireRetirementRevision(host.id, retirementRevision)
    requirePublicationRevision(host.id, publicationRevision)
    revisionByHost.set(host.id, publicationRevision + 1)
    advanceHostEndpointRevision(host.id)
    recordDurableHostIdentity(host)
  })
}

function getRetirementRevision(hostId: string): number {
  return retirementRevisionByHost.get(hostId) ?? 0
}

function requireRetirementRevision(hostId: string, expected: number): void {
  if (getRetirementRevision(hostId) !== expected) {
    throw new Error('host profile publication was retired')
  }
}

function getHostEndpointRevision(hostId: string): number {
  return endpointRevisionByHost.get(hostId) ?? 0
}

function advanceHostEndpointRevision(hostId: string): void {
  endpointRevisionByHost.set(hostId, getHostEndpointRevision(hostId) + 1)
}

function requirePublicationRevision(hostId: string, expected: number): void {
  if (getHostProfilePublicationRevision(hostId) !== expected) {
    throw new Error('host profile publication was retired')
  }
}

/** Test-only: reset publication state between module-level storage cases. */
export function resetHostProfilePublicationForTests(): void {
  pendingByHost.clear()
  revisionByHost.clear()
  retirementRevisionByHost.clear()
  endpointRevisionByHost.clear()
  endpointGenerationByHost.clear()
  publishedIdentityByHost.clear()
}
