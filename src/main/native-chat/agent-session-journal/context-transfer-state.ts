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

export function contextTransferDelivered(
  records: readonly ContextTransferRecord[],
  targetId: string
): boolean {
  return records.some(
    (row) =>
      row.kind === 'delivery' &&
      row.targetId === targetId &&
      (row.outcome?.kind === 'injected' ||
        row.outcome?.kind === 'inline-accepted' ||
        row.outcome?.kind === 'not-required')
  )
}

export function currentContextTransferTarget(
  records: readonly ContextTransferRecord[]
): ContextTransferTarget | undefined {
  const closed = new Set(
    records.filter((row) => row.kind === 'closure').map((row) => row.handoffId)
  )
  const targets = records.filter(
    (row): row is ContextTransferTarget => row.kind === 'target' && !closed.has(row.handoffId)
  )
  const replaced = new Set(targets.map((row) => row.predecessorTargetId))
  return targets.findLast((row) => !replaced.has(row.id))
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
  const handoff = records.find((row) => row.kind === 'handoff' && row.id === target.handoffId)
  if (handoff?.kind !== 'handoff') {
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
  const uncertain = records.some(
    (row) =>
      row.kind === 'delivery' &&
      row.targetId === target.id &&
      row.writeStartedAt !== undefined &&
      (!row.outcome || row.outcome.kind === 'unknown')
  )
  return { kind: uncertain ? 'uncertain' : 'owed', handoff, target }
}
