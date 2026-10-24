import { isDeepStrictEqual } from 'node:util'
import type { OrchestrationMailNotice } from '../../../shared/agent-session-message-source'
import type {
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { readAgentJournalTurnOutcome } from '../../../shared/agent-session-turn-record'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { OrchestrationDb, MessageRow } from './db'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './db'
import {
  readMailHandoff,
  structuredRecoverySource,
  type StructuredMailHandoff
} from './mail-handoff'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import {
  hasUnfilteredOrchestrationWaiter,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'

export type StructuredMailEvidence = {
  legacyNotice?: OrchestrationMailNotice | null
  epoch: string
  frontier: string
  stopInForce: boolean
  submission: AgentJournalSubmission | undefined
  owner: { itemId: string; turn: AgentJournalTurnLifecycle } | null
  personStopped: boolean
  diedTurnId: string | null
}

export function mailHandoffWasCut(
  reference: StructuredMailHandoff,
  evidence: StructuredMailEvidence
): boolean {
  const turn = evidence.owner?.turn
  const verdict =
    turn &&
    agentTurnVerdict({
      state: turn.state,
      outcome: readAgentJournalTurnOutcome(turn)
    })
  return Boolean(
    turn &&
    evidence.submission?.dispatchState !== 'rejected' &&
    evidence.epoch === reference.epoch &&
    !evidence.personStopped &&
    !evidence.stopInForce &&
    (verdict === 'failure' || verdict === 'interruption' || evidence.diedTurnId === turn.turnId)
  )
}

export function mailTransportWasRefused(evidence: StructuredMailEvidence): boolean {
  if (evidence.submission?.dispatchState !== 'rejected') {
    return false
  }
  const { category } = classifyDispatchRejection(evidence.submission)
  return category === 'undelivered' || category === 'startFailed' || category === 'transport'
}

export function structuredMailMaySubmit(
  reference: StructuredMailHandoff,
  read: (reference: StructuredMailHandoff) => StructuredMailEvidence | null
): boolean {
  const destination = read(reference)
  const original = structuredRecoverySource(reference)
  const evidence = original ? read(original) : null
  return Boolean(
    destination &&
    destination.epoch === reference.epoch &&
    (!original || (evidence && !destination.stopInForce && mailHandoffWasCut(original, evidence)))
  )
}

type SelectedHandoff = { message: MessageRow; reference: StructuredMailHandoff; recovery: boolean }

export async function selectStructuredMailHandoff(input: {
  db: OrchestrationDb
  mailbox: string
  sessionId: string
  epoch: string
  frontier: string
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
  reservedTypes: ReadonlySet<string> | undefined
  readEvidence: (reference: StructuredMailHandoff) => Promise<StructuredMailEvidence | null>
  limit?: number
  skipOperations?: ReadonlySet<string>
  manifest?: (messages: readonly MessageRow[]) => NonNullable<StructuredMailHandoff['manifest']>
}): Promise<{ messages: MessageRow[]; reference: StructuredMailHandoff } | null> {
  if (hasUnfilteredOrchestrationWaiter(input.waiters)) {
    return null
  }
  const excluded = new Set(input.reservedTypes)
  for (const waiter of input.waiters ?? []) {
    for (const type of waiter.typeFilter ?? []) {
      excluded.add(type)
    }
  }
  const authority = input.db.mailboxHandoffAuthority(input.mailbox, input.sessionId)
  if (!authority) {
    return null
  }
  const selected: SelectedHandoff[] = []
  const evidenceBySource = new Map<string, StructuredMailEvidence | null>()
  const read = async (reference: StructuredMailHandoff) => {
    const key = JSON.stringify([reference.sessionId, reference.epoch, reference.clientMessageId])
    if (!evidenceBySource.has(key)) {
      evidenceBySource.set(key, await input.readEvidence(reference).catch(() => null))
    }
    return evidenceBySource.get(key) ?? null
  }
  const limit = Math.min(
    input.limit ?? ORCHESTRATION_DELIVERY_BATCH_LIMIT,
    ORCHESTRATION_DELIVERY_BATCH_LIMIT
  )
  let afterSequence = 0
  for (;;) {
    const candidates = input.db.getAutomaticMailCandidates(input.mailbox, {
      afterSequence,
      excludeTypes: [...excluded],
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    })
    for (let message of candidates) {
      afterSequence = message.sequence
      const prior = readMailHandoff(message.handoff)
      const id = mintAgentSessionOperationId(Date.now())
      const fresh: StructuredMailHandoff = {
        version: 1,
        kind: 'structured',
        sessionId: input.sessionId,
        epoch: input.epoch,
        frontier: input.frontier,
        operationId: id,
        authorizationId: id,
        nonAdmission: 'held',
        clientMessageId: id,
        phase: 'reserved',
        authority
      }
      if (!prior) {
        selected.push({ message, reference: fresh, recovery: false })
      } else if (prior.kind === 'structured') {
        if (input.skipOperations?.has(prior.operationId)) {
          continue
        }
        const original = structuredRecoverySource(prior)
        const evidence = await read(
          prior.nonAdmission && !original
            ? { ...prior, sessionId: input.sessionId, epoch: input.epoch }
            : prior
        )
        if (!evidence) {
          continue
        }
        if (original) {
          const sourceEvidence = await read(original)
          if (
            !sourceEvidence ||
            evidence.stopInForce ||
            !mailHandoffWasCut(original, sourceEvidence)
          ) {
            continue
          }
        }
        const noEffect = prior.nonAdmission || mailTransportWasRefused(evidence)
        if (prior.authority !== authority || prior.sessionId !== input.sessionId) {
          if (!noEffect || original || prior.phase !== 'reserved') {
            continue
          }
        }
        if (prior.phase === 'reserved') {
          if (noEffect) {
            if (
              prior.nonAdmission !== 'held' &&
              prior.nonAdmission !== 'expired' &&
              prior.frontier === input.frontier
            ) {
              continue
            }
            selected.push({
              message,
              recovery: false,
              reference: {
                ...prior,
                sessionId: input.sessionId,
                epoch: input.epoch,
                authority,
                frontier: input.frontier,
                ...(prior.nonAdmission === 'held' ? {} : { operationId: id, clientMessageId: id }),
                nonAdmission: 'held'
              }
            })
          } else if (evidence.epoch === prior.epoch && !evidence.submission) {
            // An uncertain operation retains its exact original input, never a survivor subset.
            if (!selected.length || selected[0].reference.operationId === prior.operationId) {
              selected.push({ message, reference: prior, recovery: false })
            }
            continue
          } else if (
            evidence.epoch === prior.epoch &&
            evidence.submission?.dispatchState === 'accepted'
          ) {
            const offered = {
              ...prior,
              phase: 'offered' as const,
              clientMessageId: evidence.submission.clientMessageId
            }
            input.db.recordMailHandoff(input.mailbox, [message], offered)
            const current = input.db.getMessageById(message.id)
            if (!current || current.handoff !== JSON.stringify(offered)) {
              continue
            }
            message = current
          } else {
            continue
          }
          if (!evidence.submission || noEffect) {
            continue
          }
        }
        if (!message.recovery_used && mailHandoffWasCut(prior, evidence)) {
          selected.push({
            message,
            recovery: true,
            reference: {
              ...fresh,
              recoverySource: {
                sessionId: prior.sessionId,
                epoch: prior.epoch,
                clientMessageId: prior.clientMessageId
              }
            }
          })
        }
      }
      if (selected.length >= limit) {
        break
      }
    }
    if (selected.length >= limit || candidates.length < ORCHESTRATION_DELIVERY_BATCH_LIMIT) {
      break
    }
  }
  if (!selected.length) {
    return null
  }
  const uncertain = selected.find(
    (entry) =>
      entry.message.handoff === JSON.stringify(entry.reference) && !entry.reference.nonAdmission
  )
  const entries = uncertain
    ? selected.filter((entry) => entry.reference.operationId === uncertain.reference.operationId)
    : selected
  const previous = entries[0].reference
  const descriptor = uncertain
    ? previous.manifest
    : input.manifest?.(entries.map((entry) => entry.message))
  const unchanged =
    entries.every((entry) => entry.reference.operationId === previous.operationId) &&
    (!previous.manifest ||
      isDeepStrictEqual(previous.manifest, descriptor && JSON.parse(JSON.stringify(descriptor))))
  const operationId =
    uncertain?.reference.operationId ??
    (unchanged ? previous.operationId : mintAgentSessionOperationId(Date.now()))
  const messages = entries.flatMap(({ message, reference, recovery }) => {
    const member = uncertain
      ? reference
      : { ...reference, operationId, clientMessageId: operationId, manifest: descriptor }
    if (message.handoff === JSON.stringify(member)) {
      return [message]
    }
    const reserved = input.db.reserveMailHandoff(input.mailbox, message, member, recovery)
    return reserved ? [reserved] : []
  })
  const reference = readMailHandoff(messages[0]?.handoff)
  return messages.length && reference?.kind === 'structured' ? { messages, reference } : null
}
