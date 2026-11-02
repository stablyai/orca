import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import { refuse, refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'
import {
  openForWrite,
  openForProviderWrite,
  rewindInDoubt
} from './structured-agent-session-send-preparation'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import {
  replayRecordedOperation,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { mutationTurnContext } from './structured-agent-session-mutation-turn-context'
import { commandReceiptScope } from '../agent-session-journal/command-receipt-schema'
import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import { waitForStructuredAgentSessionStart } from './structured-agent-session-start-readiness'
import type { StructuredAgentSessionDeliveryPlace } from './structured-agent-session-delivery-order'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'

type ReadyOperationPlan<T> = Pick<
  MutationPlan<T>,
  'method' | 'fields' | 'operationIdScope' | 'commandReceipt'
> &
  Partial<
    Pick<MutationPlan<T>, 'replay' | 'rerunWhenReplayMissing' | 'recoverUnknownFromDurableState'>
  >
type QueuedReadyOperation<T> =
  | { result: AgentSessionMutationResult<T> }
  | {
      child: StructuredAgentSessionProviderChildIdentity
      readiness: StructuredAgentSessionStartReadiness
      place: StructuredAgentSessionDeliveryPlace
    }

export type ReadyOperationChild = StructuredAgentSessionProviderChildIdentity | null
export type ReadyOperationSelection = {
  ok: true
  child: ReadyOperationChild
  replay?: true
  deadline?: number
}

/** A send or conversation command waits only when an earlier rewind needs its provider. */
export async function runAfterRewindStart<T>(
  context: StructuredAgentSessionMutationContext,
  callerKey: string,
  envelope: AgentSessionMutationEnvelope,
  plan: ReadyOperationPlan<T>,
  run: (selection: ReadyOperationSelection) => Promise<AgentSessionMutationResult<T>>
): Promise<AgentSessionMutationResult<T>> {
  return runWithReadyStructuredAgentSessionOperation(context, callerKey, envelope, plan, run, {
    needsAgent: rewindInDoubt
  })
}

export function operationDidNotRun(expired = false): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return {
    ok: false,
    refusal: expired
      ? refuse(
          'agent_session_operation_expired',
          { reason: 'operationExpired' },
          'The operation did not run because its wait expired. Try again.'
        )
      : refuseUnclassified(
          'agent_session_owner_restart_failed',
          'The operation did not run because the agent is not ready.'
        )
  }
}

/** A ready child runs in this queue turn; only a starting child releases it to wait. */
export async function runWithReadyStructuredAgentSessionOperation<T>(
  context: StructuredAgentSessionMutationContext,
  callerKey: string,
  envelope: AgentSessionMutationEnvelope,
  plan: ReadyOperationPlan<T>,
  run: (selection: ReadyOperationSelection) => Promise<AgentSessionMutationResult<T>>,
  options: {
    beforeAgent?: (
      record: AgentSessionRecord | null
    ) => AgentSessionMutationSessionPreparation | null
    needsAgent?: (record: AgentSessionRecord | null) => boolean
    runAfterAgentEnds?: true
  } = {}
): Promise<AgentSessionMutationResult<T>> {
  const hostFingerprint = computeAgentSessionPayloadFingerprint({
    method: plan.method,
    sessionId: envelope.sessionId,
    fields: plan.fields
  })
  const conflict = agentSessionFingerprintConflict(envelope, hostFingerprint)
  if (conflict) {
    return { ok: false, refusal: conflict }
  }
  const deadline = Date.now() + STRUCTURED_AGENT_SESSION_START_WAIT_MS
  const selected = await context.serialize<QueuedReadyOperation<T>>(
    envelope.sessionId,
    async () => {
      const record = context.deps.store.getRecord(envelope.sessionId)
      if (options.needsAgent && !options.needsAgent(record)) {
        return { result: await run({ ok: true, child: null }) }
      }
      if (plan.commandReceipt) {
        if (parseAgentSessionOperationTimestamp(envelope.clientOperationId) === null) {
          return { result: await run({ ok: true, child: null }) }
        }
        // Receipt admission owns replay and unreadable-result answers, before any start.
        let recorded: boolean
        try {
          recorded =
            context.deps.store.readCommandReceipt(
              commandReceiptScope(callerKey, plan.operationIdScope),
              envelope.clientOperationId
            ).verdict !== 'absent'
        } catch (error) {
          context.deps.logger.warn('reading a command receipt failed', {
            scope: 'command-receipt-read',
            sessionId: envelope.sessionId,
            operationId: envelope.clientOperationId,
            error
          })
          return {
            result: {
              ok: false as const,
              refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId)
            }
          }
        }
        if (recorded) {
          return { result: await run({ ok: true, child: null }) }
        }
      } else {
        const evaluated = context.deps.store.evaluateMutationOperation({
          callerKey,
          envelope,
          hostFingerprint,
          now: context.now(),
          ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {})
        })
        if (evaluated?.decision.decision === 'replay') {
          if (!plan.replay) {
            return { result: await run({ ok: true, child: null, replay: true }) }
          }
          const opened = await openForWrite(context, envelope)()
          const journal = context.sessions.get(envelope.sessionId)?.journal
          if (!opened.ok || !journal) {
            return { result: await run({ ok: true, child: null, replay: true }) }
          }
          const request = {
            store: context.deps.store,
            adapter: context.deps.adapter,
            agents: context.deps.agents,
            logger: context.deps.logger,
            callerKey,
            envelope,
            journal: () => journal,
            publish: () => undefined,
            now: () => context.now()
          }
          const current = context.deps.store.evaluateMutationOperation({
            callerKey,
            envelope,
            hostFingerprint,
            now: context.now(),
            ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {})
          })
          if (current?.decision.decision !== 'replay') {
            return { result: await run({ ok: true, child: null, replay: true }) }
          }
          const turn = mutationTurnContext(request, journal, current.record)
          const answer = replayRecordedOperation(
            { envelope, plan: { ...plan, replay: plan.replay } },
            turn,
            current.decision.row
          )
          if (answer !== 'rerun') {
            return { result: await run({ ok: true, child: null, replay: true }) }
          }
        } else if (!evaluated || evaluated.decision.decision !== 'admit') {
          return {
            result: await run({
              ok: true,
              child: null
            })
          }
        }
      }
      const select = async () => {
        const opened = await openForWrite(context, envelope)()
        if (!opened.ok) {
          return opened
        }
        const checked = options.beforeAgent?.(context.deps.store.getRecord(envelope.sessionId))
        if (checked && !checked.ok) {
          return checked
        }
        const ensured = await context.ensureAgent(envelope.sessionId)
        if (!ensured.ok) {
          return ensured
        }
        const child = context.sessions.get(envelope.sessionId)?.child
        if (!child || child.close) {
          return operationDidNotRun()
        }
        const identity = { generation: child.generation, fence: child.fence }
        if (child.phase === 'ready') {
          return { ok: true as const, child: identity, deadline }
        }
        const readiness = context.startupAttempts.readiness(envelope.sessionId, identity)
        return readiness
          ? { ok: true as const, child: identity, readiness }
          : options.runAfterAgentEnds
            ? { ok: true as const, child: identity }
            : operationDidNotRun()
      }
      const child = await select().catch((error: unknown) => {
        context.deps.logger.warn('selecting an agent for an operation failed', {
          scope: 'operation-agent-start',
          sessionId: envelope.sessionId,
          error
        })
        return operationDidNotRun()
      })
      if (!child.ok) {
        return { result: child }
      }
      if (!child.readiness) {
        return { result: await run(child) }
      }
      context.deliveryOrder.reconcile(
        envelope.sessionId,
        context.sessions.get(envelope.sessionId)?.journal.submissions() ?? []
      )
      const place = context.deliveryOrder.reserve(envelope.sessionId)
      return {
        child: child.child,
        readiness: child.readiness,
        place
      }
    }
  )
  if ('result' in selected) {
    return selected.result
  }
  try {
    const ready = selected.readiness.wait()
    const outcome = await waitForStructuredAgentSessionStart(
      Promise.all([ready, selected.place.before]).then(([outcome]) =>
        outcome === 'ready' ? 'ready' : 'ended'
      ),
      deadline - Date.now()
    )
    if (outcome !== 'ready' && !(outcome === 'ended' && options.runAfterAgentEnds)) {
      return operationDidNotRun(outcome === 'timeout')
    }
    if (Date.now() >= deadline) {
      return operationDidNotRun(true)
    }
    return await context.serialize(envelope.sessionId, () =>
      // Admission re-reads the journal here after readiness and answers a competing settlement.
      run({ ok: true, child: selected.child, deadline })
    )
  } finally {
    selected.place.release()
  }
}

/** Replay uses the ledger answer; a new operation uses only its selected ready child. */
export function openWithReadyStructuredAgentSessionChild(
  context: StructuredAgentSessionMutationContext,
  envelope: AgentSessionMutationEnvelope,
  selection: ReadyOperationSelection
): (ledger: 'admit' | 'replay') => Promise<AgentSessionMutationSessionPreparation> {
  return async (ledger) => {
    const opened = await openForProviderWrite(context, envelope)()
    if (!opened.ok || ledger === 'replay') {
      return opened
    }
    if (!selection.child) {
      return selection.replay
        ? { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
        : operationDidNotRun()
    }
    if (selection.deadline !== undefined && Date.now() >= selection.deadline) {
      return operationDidNotRun(true)
    }
    const child = context.sessions.get(envelope.sessionId)?.child
    return child?.phase === 'ready' && !child.close && sameProviderChild(child, selection.child)
      ? opened
      : operationDidNotRun()
  }
}
