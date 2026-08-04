import { randomBytes } from 'node:crypto'
import type { DirectSshAuthority, SshProviderEpoch } from '../../shared/ssh-types'
import {
  advanceSshConnectionGeneration,
  getSshConnectionGeneration
} from './ssh-connection-generation'

const authorityByTarget = new Map<string, DirectSshAuthority>()
type ProviderRequestAbortRegistration = {
  authority: DirectSshAuthority
  controller: AbortController
  onAbort: () => void
}
const providerRequestAbortsByTarget = new Map<string, Set<ProviderRequestAbortRegistration>>()
let providerEpochSequence = 0

function issueSshProviderEpoch(): SshProviderEpoch {
  if (providerEpochSequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error('SSH provider epoch sequence exhausted')
  }
  providerEpochSequence += 1
  return `${randomBytes(12).toString('hex')}-${providerEpochSequence.toString(36)}` as SshProviderEpoch
}

function createAuthority(targetId: string, connectionGeneration: number): DirectSshAuthority {
  return {
    targetId,
    providerEpoch: issueSshProviderEpoch(),
    connectionGeneration
  }
}

function authoritiesEqual(left: DirectSshAuthority, right: DirectSshAuthority): boolean {
  return (
    left.targetId === right.targetId &&
    left.providerEpoch === right.providerEpoch &&
    left.connectionGeneration === right.connectionGeneration
  )
}

function removeProviderRequestAbort(registration: ProviderRequestAbortRegistration): void {
  registration.controller.signal.removeEventListener('abort', registration.onAbort)
  const registrations = providerRequestAbortsByTarget.get(registration.authority.targetId)
  if (!registrations?.delete(registration)) {
    return
  }
  if (registrations.size === 0) {
    providerRequestAbortsByTarget.delete(registration.authority.targetId)
  }
}

function abortProviderRequestsForAuthority(authority: DirectSshAuthority): void {
  const registrations = providerRequestAbortsByTarget.get(authority.targetId)
  if (!registrations) {
    return
  }
  const matching = [...registrations].filter((registration) =>
    authoritiesEqual(registration.authority, authority)
  )
  for (const registration of matching) {
    removeProviderRequestAbort(registration)
  }
  for (const registration of matching) {
    if (!registration.controller.signal.aborted) {
      registration.controller.abort()
    }
  }
}

function abortAllProviderRequests(): void {
  const registrations = [...providerRequestAbortsByTarget.values()].flatMap((entries) => [
    ...entries
  ])
  providerRequestAbortsByTarget.clear()
  for (const registration of registrations) {
    registration.controller.signal.removeEventListener('abort', registration.onAbort)
  }
  for (const registration of registrations) {
    if (!registration.controller.signal.aborted) {
      registration.controller.abort()
    }
  }
}

export function registerSshProviderRequestAbort(
  authority: DirectSshAuthority,
  controller: AbortController
): () => void {
  if (controller.signal.aborted || !isCurrentSshProviderAuthority(authority)) {
    return () => {}
  }
  const capturedAuthority = { ...authority }
  const registration: ProviderRequestAbortRegistration = {
    authority: capturedAuthority,
    controller,
    onAbort: () => removeProviderRequestAbort(registration)
  }
  const registrations =
    providerRequestAbortsByTarget.get(authority.targetId) ??
    new Set<ProviderRequestAbortRegistration>()
  registrations.add(registration)
  providerRequestAbortsByTarget.set(authority.targetId, registrations)
  controller.signal.addEventListener('abort', registration.onAbort, { once: true })
  return () => removeProviderRequestAbort(registration)
}

export function getSshProviderAuthority(targetId: string): DirectSshAuthority {
  const generation = getSshConnectionGeneration(targetId)
  const current = authorityByTarget.get(targetId)
  if (current?.connectionGeneration === generation) {
    return current
  }
  const authority = createAuthority(targetId, generation)
  authorityByTarget.set(targetId, authority)
  return authority
}

export function rotateSshProviderAuthority(targetId: string): DirectSshAuthority {
  const previous = authorityByTarget.get(targetId)
  const previousGeneration = getSshConnectionGeneration(targetId)
  const nextGeneration = advanceSshConnectionGeneration(targetId)
  const authority = createAuthority(targetId, nextGeneration)
  if (nextGeneration !== previousGeneration + 1) {
    authorityByTarget.clear()
    authorityByTarget.set(targetId, authority)
    abortAllProviderRequests()
    return authority
  }
  authorityByTarget.set(targetId, authority)
  if (previous) {
    abortProviderRequestsForAuthority(previous)
  }
  return authority
}

export function isCurrentSshProviderAuthority(authority: DirectSshAuthority): boolean {
  const current = authorityByTarget.get(authority.targetId)
  return (
    current !== undefined &&
    current.connectionGeneration === getSshConnectionGeneration(authority.targetId) &&
    authoritiesEqual(current, authority)
  )
}

export function resetSshProviderAuthorities(): void {
  abortAllProviderRequests()
  authorityByTarget.clear()
}
