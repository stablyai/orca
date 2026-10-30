import type { IPtyProvider, PtyProcessInfo } from '../providers/pty-provider-contract'
import type { DaemonSessionOwnerResolution } from './daemon-session-owner-resolution'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { chooseSessionOwner, type OwnerCandidate } from './daemon-session-owner-choice'
import { randomUUID } from 'node:crypto'
import { worktreePtyOwnership } from '../providers/worktree-pty-ownership'

export type ProviderInventory<T> = {
  provider: T
  processes: PtyProcessInfo[] | null
  failure?: { error: unknown }
}

export type OwnerInventory<T extends IPtyProvider> = {
  candidatesBySessionId: Map<string, OwnerCandidate<T>[]>
  complete: boolean
  epoch: number
  failure?: { error: unknown }
}

const inventorySourceIds = new WeakMap<IPtyProvider, string>()

function inventorySourceId(provider: IPtyProvider): string {
  const existing = inventorySourceIds.get(provider)
  if (existing) {
    return existing
  }
  const id = randomUUID()
  inventorySourceIds.set(provider, id)
  return id
}

export function indexDaemonOwnerInventory<T extends IPtyProvider>(
  entries: ProviderInventory<T>[],
  epoch: number,
  currentEpoch: number,
  recordRoute: (id: string, provider: T, incarnationId?: string) => void,
  forgetIncarnation: (id: string) => void,
  readRoute: (id: string) => { provider: IPtyProvider; incarnationId?: string } | undefined,
  replaceEstablishedRoutes = false
): OwnerInventory<T> {
  const candidatesBySessionId = new Map<string, OwnerCandidate<T>[]>()
  let complete = true
  for (const entry of entries) {
    if (!entry.processes) {
      complete = false
      continue
    }
    for (const process of entry.processes) {
      const candidates = candidatesBySessionId.get(process.id) ?? []
      candidates.push({ provider: entry.provider, process })
      candidatesBySessionId.set(process.id, candidates)
    }
  }
  const inventory = {
    candidatesBySessionId,
    complete,
    epoch,
    failure: entries.find((entry) => entry.failure)?.failure
  }
  if (complete && epoch === currentEpoch) {
    for (const [sessionId, candidates] of candidatesBySessionId) {
      const route = readRoute(sessionId)
      let owner = selectInventoryOwner(candidates, complete)
      if (!owner) {
        // Match the recorded incarnation to disambiguate ownership.
        const exact = route?.incarnationId
          ? selectInventoryOwner(candidates, complete, route.incarnationId, true)
          : undefined
        if (exact?.provider === route?.provider) {
          owner = exact
        }
      }
      if (owner && (!route || route.provider === owner.provider || replaceEstablishedRoutes)) {
        recordRoute(sessionId, owner.provider, owner.process.incarnationId)
      } else {
        // Inventory ambiguity revokes generation proof, not established input authority.
        forgetIncarnation(sessionId)
      }
    }
  }
  return inventory
}

function selectInventoryOwner<T>(
  candidates: readonly OwnerCandidate<T>[],
  complete: boolean,
  expectedIncarnationId?: string,
  expectedIncarnationIsAuthoritative = false
): OwnerCandidate<T> | undefined {
  const owner = chooseSessionOwner({
    candidates,
    inventoryComplete: complete,
    expectedIncarnationId,
    expectedIncarnationIsAuthoritative
  })
  if (!owner || (expectedIncarnationId && owner.process.incarnationId === expectedIncarnationId)) {
    return owner
  }
  return candidates.every(({ process }) => process.incarnationId === owner.process.incarnationId)
    ? owner
    : undefined
}

export function resolveDaemonInventoryOwner<T extends IPtyProvider>(
  inventory: OwnerInventory<T>,
  sessionId: string,
  hasProviders: boolean,
  recordRoute: (id: string, provider: T, incarnationId?: string) => void,
  expectedIncarnationId?: string,
  expectedIncarnationIsAuthoritative = false
): DaemonSessionOwnerResolution<T> {
  const candidates = inventory.candidatesBySessionId.get(sessionId) ?? []
  const owner = selectInventoryOwner(
    candidates,
    inventory.complete,
    expectedIncarnationId,
    expectedIncarnationIsAuthoritative
  )
  if (owner) {
    recordRoute(sessionId, owner.provider, owner.process.incarnationId)
    return { kind: 'owner', provider: owner.provider }
  }
  return inventory.complete && candidates.length === 0 && hasProviders
    ? { kind: 'absent' }
    : { kind: 'unknown' }
}

export function resolveDaemonInventoryTerminationOwner<T extends IPtyProvider>(
  inventory: OwnerInventory<T>,
  sessionId: string,
  hasProviders: boolean,
  recordRoute: (id: string, provider: T, incarnationId?: string) => void,
  incarnationId: string
) {
  const resolution = resolveDaemonInventoryOwner(
    inventory,
    sessionId,
    hasProviders,
    recordRoute,
    incarnationId,
    true
  )
  const candidates = inventory.candidatesBySessionId.get(sessionId) ?? []
  return resolution.kind === 'unknown' &&
    inventory.complete &&
    candidates.length > 0 &&
    candidates.every(
      ({ process }) => process.incarnationId && process.incarnationId !== incarnationId
    )
    ? { kind: 'replaced' as const }
    : resolution
}

export function selectListedDaemonProcesses<T extends IPtyProvider>(
  inventory: OwnerInventory<T>,
  routes: ReadonlyMap<string, IPtyProvider>,
  incarnations: ReadonlyMap<string, string | undefined>,
  opts?: Parameters<IPtyProvider['listProcesses']>[0]
): PtyProcessInfo[] {
  if (!inventory.complete) {
    throw new TerminalSessionOwnerUnverifiedError('incomplete inventory')
  }
  const processes: PtyProcessInfo[] = []
  const ownsWorktree = opts?.worktreeId ? worktreePtyOwnership(opts.worktreeId) : undefined
  const ptyIds = opts?.ptyIds ? new Set(opts.ptyIds) : undefined
  for (const [sessionId, candidates] of inventory.candidatesBySessionId) {
    if (
      (ptyIds && !ptyIds.has(sessionId)) ||
      (ownsWorktree && !candidates.some(({ process }) => ownsWorktree(process)))
    ) {
      continue
    }
    const routed = routes.get(sessionId)
    const incarnationId = incarnations.get(sessionId)
    const candidate = selectInventoryOwner(
      candidates,
      inventory.complete,
      incarnationId,
      Boolean(incarnationId)
    )
    const owner = candidate?.provider === routed ? candidate : undefined
    if (opts?.includeUnrouted) {
      processes.push(
        ...candidates.map((candidate) => ({
          ...candidate.process,
          inventorySourceId: inventorySourceId(candidate.provider),
          ...(owner ? { routed: candidate === owner } : {})
        }))
      )
      continue
    }
    // Omitting an ambiguous id is false exit proof; either candidate could misstate route authority.
    if (
      !owner ||
      (ownsWorktree &&
        (!ownsWorktree(owner.process) ||
          candidates.some((candidate) => candidate !== owner && ownsWorktree(candidate.process))))
    ) {
      throw new TerminalSessionOwnerUnverifiedError(sessionId)
    }
    processes.push(owner.process)
  }
  return processes
}
