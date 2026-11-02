import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandleChain,
  type AgentSessionProviderHandleLink
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type {
  ContextTransferDelivery,
  ContextTransferRecord,
  ContextTransferHandoff,
  ContextTransferTarget
} from './context-transfer-record'

export type ContextTransferState =
  | { kind: 'none' }
  | {
      kind: 'unpublished' | 'owed' | 'uncertain' | 'settled'
      handoff: ContextTransferHandoff
      target: ContextTransferTarget
    }

/** One pass over the facts; reused while the cached frozen array is unchanged. */
export type ContextTransferLookup = {
  handoffs: ReadonlyMap<string, ContextTransferHandoff>
  targets: ReadonlyMap<string, ContextTransferTarget>
  deliveries: ReadonlyMap<string, ContextTransferDelivery>
  deliveriesByTarget: ReadonlyMap<string, readonly ContextTransferDelivery[]>
  /** Inline deliveries still awaiting a final outcome, by the input that carried them. */
  carriers: ReadonlyMap<string, readonly ContextTransferDelivery[]>
  current: ContextTransferTarget | undefined
}

const lookups = new WeakMap<readonly ContextTransferRecord[], ContextTransferLookup>()

export function contextTransferLookup(
  records: readonly ContextTransferRecord[]
): ContextTransferLookup {
  const cached = lookups.get(records)
  if (cached) {
    return cached
  }
  const handoffs = new Map<string, ContextTransferHandoff>()
  const targets = new Map<string, ContextTransferTarget>()
  const deliveries = new Map<string, ContextTransferDelivery>()
  const deliveriesByTarget = new Map<string, ContextTransferDelivery[]>()
  const carriers = new Map<string, ContextTransferDelivery[]>()
  const closed = new Set<string>()
  for (const row of records) {
    if (row.kind === 'handoff') {
      handoffs.set(row.id, row)
    } else if (row.kind === 'target') {
      targets.set(row.id, row)
    } else if (row.kind === 'delivery') {
      deliveries.set(row.id, row)
      const list = deliveriesByTarget.get(row.targetId)
      if (list) {
        list.push(row)
      } else {
        deliveriesByTarget.set(row.targetId, [row])
      }
      if (
        row.mode === 'inline' &&
        row.carrierInputId &&
        (row.outcome === null || row.outcome.kind === 'unknown')
      ) {
        carriers.set(row.carrierInputId, [...(carriers.get(row.carrierInputId) ?? []), row])
      }
    } else {
      closed.add(row.handoffId)
    }
  }
  const open = [...targets.values()].filter((row) => !closed.has(row.handoffId))
  const replaced = new Set(open.map((row) => row.predecessorTargetId))
  const lookup = {
    handoffs,
    targets,
    deliveries,
    deliveriesByTarget,
    carriers,
    current: open.findLast((row) => !replaced.has(row.id))
  }
  // Only the cached facts are frozen; callers' working copies change in place.
  if (Object.isFrozen(records)) {
    lookups.set(records, lookup)
  }
  return lookup
}

export function contextTransferDelivered(
  records: readonly ContextTransferRecord[],
  targetId: string
): boolean {
  return (contextTransferLookup(records).deliveriesByTarget.get(targetId) ?? []).some(
    (row) =>
      row.outcome?.kind === 'injected' ||
      row.outcome?.kind === 'inline-accepted' ||
      row.outcome?.kind === 'not-required'
  )
}

export function currentContextTransferTarget(
  records: readonly ContextTransferRecord[]
): ContextTransferTarget | undefined {
  return contextTransferLookup(records).current
}

function inheritsTarget(
  chain: AgentSessionProviderHandleChain,
  head: AgentSessionProviderHandleLink,
  target: AgentSessionProviderHandleLink
): boolean {
  const keys = new Set([agentSessionProviderHandleKey(target.handle)])
  for (const link of chain) {
    if (link.origin === 'forked' && link.forkedFromKey && keys.has(link.forkedFromKey)) {
      keys.add(agentSessionProviderHandleKey(link.handle))
    }
  }
  return keys.has(agentSessionProviderHandleKey(head.handle))
}

/** Applicability follows the checked native lineage, never merely the latest row in the table. */
export function deriveContextTransferState(
  records: readonly ContextTransferRecord[],
  chain: AgentSessionProviderHandleChain
): ContextTransferState {
  const head = agentSessionProviderHandleChainHead(chain)
  const target = currentContextTransferTarget(records)
  if (!head || !target) {
    return { kind: 'none' }
  }
  const lookup = contextTransferLookup(records)
  const handoff = lookup.handoffs.get(target.handoffId)
  if (!handoff) {
    throw new Error('Context target lost its source')
  }
  if (!target.targetLink) {
    return target.sourceLinkId === head.linkId
      ? { kind: 'unpublished', handoff, target }
      : { kind: 'none' }
  }
  const same =
    agentSessionProviderHandleRoot(target.targetLink.handle) ===
    agentSessionProviderHandleRoot(head.handle)
  const delivered = contextTransferDelivered(records, target.id)
  if (!same) {
    return !delivered && inheritsTarget(chain, head, target.targetLink)
      ? { kind: 'uncertain', handoff, target }
      : { kind: 'none' }
  }
  if (delivered) {
    return { kind: 'settled', handoff, target }
  }
  const uncertain = (lookup.deliveriesByTarget.get(target.id) ?? []).some(
    (row) => row.writeStartedAt !== undefined && (!row.outcome || row.outcome.kind === 'unknown')
  )
  return { kind: uncertain ? 'uncertain' : 'owed', handoff, target }
}
