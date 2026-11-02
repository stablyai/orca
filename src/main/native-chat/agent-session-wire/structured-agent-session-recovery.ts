import { deriveContextTransferState } from '../agent-session-journal/context-transfer-state'
import { randomUUID } from 'node:crypto'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { writeContextTransfer } from '../agent-session-journal/context-transfer-repository'
import { ContextTransferFacts } from '../agent-session-journal/context-transfer-facts'
import type {
  ContextTransferHandoff,
  ContextTransferTarget
} from '../agent-session-journal/context-transfer-record'
import { captureRecoveryContext } from '../agent-session-journal/context-transfer-capture'
import type {
  ConstructionStep,
  RecoveryConstructionPermit
} from './structured-agent-session-construction'

export function prepareNativeRecovery(input: {
  store: AgentSessionRecordStore
  journal: AgentSessionJournal
  record: AgentSessionRecord
  source: Extract<ConstructionStep<unknown>, { kind: 'history-unavailable' }>['sourceLink']
  trigger: ContextTransferHandoff['trigger']
  now: number
}): RecoveryConstructionPermit {
  const { store, journal, record, source } = input
  const head = agentSessionProviderHandleChainHead(
    store.requireWritableRecord(record.sessionId).providerHandleChain
  )
  if (
    head?.linkId !== source.linkId ||
    store.requireWritableRecord(record.sessionId).lease.runtimeFence !== record.lease.runtimeFence
  ) {
    throw new Error('Recovery source changed')
  }
  let permit: RecoveryConstructionPermit | undefined
  journal.contextTransfers.commit((db) => {
    const facts = new ContextTransferFacts(db, record.sessionId)
    const state = deriveContextTransferState(facts, record.providerHandleChain)
    const current = state.kind === 'none' ? undefined : state.target
    const prior = current
    let handoff =
      state.kind !== 'none' && !facts.delivered(state.target.id) ? state.handoff : undefined
    if (!handoff) {
      const frozen = captureRecoveryContext(journal.snapshot(), journal.canonicalItemId)
      const id = randomUUID()
      handoff = {
        kind: 'handoff',
        id,
        handoffId: id,
        sessionId: record.sessionId,
        sourceLink: source,
        sourceCursor: journal.cursor(),
        contextFloor: frozen.contextFloor,
        trigger: input.trigger,
        capturedAt: input.now,
        capture: frozen.capture,
        ...(prior ? { supersedesHandoffId: prior.handoffId } : {})
      }
      writeContextTransfer(db, handoff)
    }
    if (
      current?.targetLink === null &&
      current.sourceLinkId === source.linkId &&
      current.fence === record.lease.runtimeFence
    ) {
      permit = {
        handoffId: current.handoffId,
        targetAttemptId: current.id,
        sourceLinkId: source.linkId,
        fence: record.lease.runtimeFence
      }
      return
    }
    const target: ContextTransferTarget = {
      kind: 'target',
      id: randomUUID(),
      handoffId: handoff.id,
      sessionId: record.sessionId,
      preparedAt: input.now,
      fence: record.lease.runtimeFence,
      acquisitionGeneration: null,
      sourceLinkId: source.linkId,
      predecessorTargetId: prior?.id ?? null,
      targetLink: null,
      firstInputId: null
    }
    writeContextTransfer(db, target)
    permit = {
      handoffId: handoff.id,
      targetAttemptId: target.id,
      sourceLinkId: source.linkId,
      fence: record.lease.runtimeFence
    }
  })
  if (!permit) {
    throw new Error('Recovery preparation did not commit')
  }
  return permit
}

/** A prepared fresh-target attempt whose source is still this chat's head; the open must build it. */
export function hasPreparedRecoveryAttempt(
  journal: AgentSessionJournal,
  record: AgentSessionRecord
): boolean {
  const state = deriveContextTransferState(
    journal.contextTransfers.facts(),
    record.providerHandleChain
  )
  const source = agentSessionProviderHandleChainHead(record.providerHandleChain)
  return (
    state.kind === 'unpublished' &&
    !state.target.targetLink &&
    !!source &&
    state.target.sourceLinkId === source.linkId
  )
}

export function recoveryConstructionIntent(input: {
  store: AgentSessionRecordStore
  journal: AgentSessionJournal
  record: AgentSessionRecord
  now: number
}) {
  const source = agentSessionProviderHandleChainHead(input.record.providerHandleChain)
  if (!source || !hasPreparedRecoveryAttempt(input.journal, input.record)) {
    return undefined
  }
  const permit = prepareNativeRecovery({ ...input, source, trigger: 'uncertain-context-delivery' })
  return { kind: 'recovery' as const, permit }
}
