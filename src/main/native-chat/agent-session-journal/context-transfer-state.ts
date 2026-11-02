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

/** Keyed facts, kept current one write at a time for the cached array so lookups never rescan history. */
export class ContextTransferLookup {
  readonly byId = new Map<string, ContextTransferRecord>()
  readonly handoffs = new Map<string, ContextTransferHandoff>()
  readonly targets = new Map<string, ContextTransferTarget>()
  readonly deliveries = new Map<string, ContextTransferDelivery>()
  readonly deliveriesByTarget = new Map<string, readonly ContextTransferDelivery[]>()
  /** Inline deliveries still awaiting a final outcome, by the input that carried them. */
  readonly carriers = new Map<string, readonly ContextTransferDelivery[]>()
  /** Handoffs no successful context edit has closed. */
  readonly openHandoffs = new Set<string>()
  readonly closureCommands = new Set<string>()
  private readonly closed = new Set<string>()
  private openTargets: string[] = []
  private readonly replaced = new Map<string, number>()

  constructor(records: readonly ContextTransferRecord[]) {
    for (const record of records) {
      this.apply(record)
    }
  }

  get current(): ContextTransferTarget | undefined {
    for (let index = this.openTargets.length - 1; index >= 0; index--) {
      const id = this.openTargets[index]!
      if (!this.replaced.get(id)) {
        return this.targets.get(id)
      }
    }
    return undefined
  }

  apply(record: ContextTransferRecord): void {
    const previous = this.byId.get(record.id)
    this.byId.set(record.id, record)
    if (record.kind === 'handoff') {
      this.handoffs.set(record.id, record)
      if (!this.closed.has(record.id)) {
        this.openHandoffs.add(record.id)
      }
    } else if (record.kind === 'target') {
      this.targets.set(record.id, record)
      if (!previous && !this.closed.has(record.handoffId)) {
        this.openTargets.push(record.id)
        this.countReplaced(record.predecessorTargetId, 1)
      }
    } else if (record.kind === 'delivery') {
      this.deliveries.set(record.id, record)
      this.deliveriesByTarget.set(record.targetId, [
        ...(this.deliveriesByTarget.get(record.targetId) ?? []).filter(
          (row) => row.id !== record.id
        ),
        record
      ])
      const carrier = record.carrierInputId
      if (record.mode === 'inline' && carrier) {
        const waiting = (this.carriers.get(carrier) ?? []).filter((row) => row.id !== record.id)
        if (record.outcome === null || record.outcome.kind === 'unknown') {
          waiting.push(record)
        }
        if (waiting.length) {
          this.carriers.set(carrier, waiting)
        } else {
          this.carriers.delete(carrier)
        }
      }
    } else {
      this.closureCommands.add(record.commandId)
      if (!this.closed.has(record.handoffId)) {
        this.closed.add(record.handoffId)
        this.openHandoffs.delete(record.handoffId)
        this.openTargets = this.openTargets.filter((id) => {
          const target = this.targets.get(id)
          if (target?.handoffId !== record.handoffId) {
            return true
          }
          this.countReplaced(target.predecessorTargetId, -1)
          return false
        })
      }
    }
  }

  private countReplaced(id: string | null, change: number): void {
    if (id !== null) {
      this.replaced.set(id, (this.replaced.get(id) ?? 0) + change)
    }
  }
}

const lookups = new WeakMap<readonly ContextTransferRecord[], ContextTransferLookup>()

/** Track an owned fact array whose every later change goes through `applyContextTransferRecord`. */
export function trackContextTransferLookup(records: readonly ContextTransferRecord[]): void {
  lookups.set(records, new ContextTransferLookup(records))
}

export function applyContextTransferRecord(
  records: readonly ContextTransferRecord[],
  record: ContextTransferRecord
): void {
  lookups.get(records)?.apply(record)
}

export function contextTransferLookup(
  records: readonly ContextTransferRecord[]
): ContextTransferLookup {
  return lookups.get(records) ?? new ContextTransferLookup(records)
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
