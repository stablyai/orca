import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import {
  AGENT_SESSION_RETIREMENT_TTL_MS,
  MAX_AGENT_SESSION_RETIREMENT_RECEIPTS,
  type AgentSessionRetirementReceipt,
  type AgentSessionRetirements
} from '../../../shared/agent-session-retirement'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { cancelledJournalPromptBody } from '../agent-session-journal/journal-prompt-body-bounds'
import type { StructuredAgentSessionLeaseStore } from './structured-agent-session-lease-release'

export type RetirementContext = {
  store: StructuredAgentSessionLeaseStore
  sessionId: string
  journal: AgentSessionJournal
  now: () => number
  onError?: (error: unknown) => void
}

/** Capture precedes reservation: subsequent work can never widen this observation. */
export async function preserveStructuredSessionRetirement(
  input: RetirementContext
): Promise<boolean> {
  const record = input.store.getRecord(input.sessionId)
  if (!record) {
    return true
  }
  const legacy = !record.lease.settlementRetryRequired
  if (legacy && (record.lease.claimStatus !== 'released' || record.lease.ownerProcess !== null)) {
    return true
  }
  if (legacy && record.retirements?.lastCapturedFence === record.lease.runtimeFence) {
    return true
  }
  const id =
    record.lease.settlementRetryId ?? `historical:${record.sessionId}:${record.lease.runtimeFence}`
  const captured = await input.journal.retirement.capture()
  if (
    legacy &&
    captured.disposition === 'captured' &&
    captured.capture.items.length === 0 &&
    captured.capture.submissions.length === 0
  ) {
    return true
  }
  try {
    await input.store.transitionHandoff(input.sessionId, (latest) => {
      if (
        latest.lease.runtimeFence !== record.lease.runtimeFence ||
        (legacy
          ? latest.lease.claimStatus !== 'released' || latest.lease.ownerProcess !== null
          : latest.lease.settlementRetryId !== id)
      ) {
        throw new Error('agent_session_checkpoint_stale')
      }
      const now = input.now()
      const retirements = retainedRetirements(latest, now)
      retirements.lastCapturedFence = record.lease.runtimeFence
      if (!retirements.receipts.some((receipt) => receipt.id === id)) {
        if (captured.disposition === 'abandoned') {
          abandon(retirements, captured.reason, now)
        } else if (retirements.receipts.length >= MAX_AGENT_SESSION_RETIREMENT_RECEIPTS) {
          abandon(retirements, 'quota', now)
        } else {
          retirements.receipts.push({
            id,
            fence: record.lease.runtimeFence,
            observedAt: record.lease.deathEvidence?.observedAt ?? now,
            ...(record.lease.deathEvidence ? { evidence: record.lease.deathEvidence } : {}),
            capture: captured.capture
          })
        }
      }
      const preserveHandoff = latest.lease.handoffStage === 'old-owner-stopped'
      return {
        ...latest,
        retirements,
        lease: {
          ...latest.lease,
          settlementRetryRequired: undefined,
          settlementRetryId: undefined,
          handoffStage: preserveHandoff ? latest.lease.handoffStage : null,
          handoffOperationId: preserveHandoff ? latest.lease.handoffOperationId : null
        }
      }
    })
    return true
  } catch (error) {
    input.onError?.(error)
    // The required ownership record write still gates admission; exact repair remains safe.
    if (captured.disposition === 'captured') {
      await materializeRetirement(input, {
        id,
        fence: record.lease.runtimeFence,
        observedAt: input.now(),
        capture: captured.capture
      }).catch(input.onError ?? (() => undefined))
    }
    return false
  }
}

export async function retryStructuredSessionRetirements(
  input: RetirementContext
): Promise<boolean> {
  const record = input.store.getRecord(input.sessionId)
  if (!record?.retirements) {
    return true
  }
  await publishAbandonment(input, record)
  if (!record.retirements.receipts.length) {
    return true
  }
  const discharged = new Set<string>()
  let complete = true
  for (const receipt of record.retirements.receipts) {
    try {
      if (input.now() - receipt.observedAt < AGENT_SESSION_RETIREMENT_TTL_MS) {
        await materializeRetirement(input, receipt)
        discharged.add(receipt.id)
      }
    } catch (error) {
      complete = false
      input.onError?.(error)
    }
  }
  try {
    await input.store.transitionHandoff(input.sessionId, (latest) => {
      const retirements = retainedRetirements(latest, input.now())
      retirements.receipts = retirements.receipts.filter((entry) => !discharged.has(entry.id))
      return { ...latest, retirements }
    })
  } catch (error) {
    input.onError?.(error)
    return false
  }
  const latest = input.store.getRecord(input.sessionId)
  if (latest) {
    await publishAbandonment(input, latest)
  }
  return complete
}

async function materializeRetirement(
  input: RetirementContext,
  receipt: AgentSessionRetirementReceipt
): Promise<void> {
  const record = input.store.getRecord(input.sessionId)
  if (!record) {
    throw new Error('agent_session_not_found')
  }
  const fence = record.lease.runtimeFence
  const items = new Map(input.journal.snapshot().items.map((item) => [item.itemId, item]))
  for (const target of receipt.capture.items) {
    const item = items.get(target.itemId)
    if (!item) {
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    const body =
      turn?.state === 'running'
        ? agentJournalTurnBody({ ...turn, state: 'unverifiable', completedAt: undefined })
        : item.body.kind === 'tool-call' && item.body.state === 'running'
          ? { ...item.body, state: 'failed' as const }
          : (item.body.kind === 'approval' || item.body.kind === 'question') &&
              item.body.resolution.state === 'pending'
            ? cancelledJournalPromptBody(item.body)
            : null
    if (body) {
      await input.journal.retirement.repairItem({ capture: receipt.capture, target, fence, body })
    }
  }
  for (const target of receipt.capture.submissions) {
    await input.journal.retirement.repairSubmission({
      capture: receipt.capture,
      target,
      fence,
      reason: 'provider_exited_before_acknowledgement'
    })
  }
}

function retainedRetirements(record: AgentSessionRecord, now: number): AgentSessionRetirements {
  const previous = record.retirements ?? { receipts: [], abandonedCount: 0 }
  const next = { ...previous, receipts: [...previous.receipts] }
  next.receipts = next.receipts.filter((receipt) => {
    if (now - receipt.observedAt < AGENT_SESSION_RETIREMENT_TTL_MS) {
      return true
    }
    abandon(next, 'expired', now)
    return false
  })
  return next
}
function abandon(
  state: AgentSessionRetirements,
  reason: 'unreadable' | 'quota' | 'expired',
  now: number
): void {
  state.abandonedCount = Math.min(Number.MAX_SAFE_INTEGER, state.abandonedCount + 1)
  state.lastAbandonedAt = now
  state.lastAbandonedReason = reason
}

async function publishAbandonment(
  input: RetirementContext,
  record: AgentSessionRecord
): Promise<void> {
  const count = record.retirements?.abandonedCount ?? 0
  if (!count) {
    return
  }
  const text = `Some earlier activity could not be reconciled (${count} historical observations). Current work is unaffected.`
  if (
    input.journal
      .snapshot()
      .items.some((item) => item.body.kind === 'status' && item.body.text === text)
  ) {
    return
  }
  try {
    await input.journal.appendItem(
      { provider: 'orca', clientMessageId: 'historical-retirement-abandonment' },
      { kind: 'status', text },
      { fence: record.lease.runtimeFence, recovered: true }
    )
  } catch (error) {
    input.onError?.(error)
  }
}
