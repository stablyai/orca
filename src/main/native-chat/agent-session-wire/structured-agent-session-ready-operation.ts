import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'
import { openForWrite, rewindInDoubt } from './structured-agent-session-send-preparation'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import {
  replayRecordedOperation,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import type { ReadyOperationPlan } from './structured-agent-session-ready-operation-plan'
import { mutationReplayContext } from './structured-agent-session-mutation-turn-context'
import { commandReceiptScope } from '../agent-session-journal/command-receipt-schema'
import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import { waitForStructuredAgentSessionStart } from './structured-agent-session-start-readiness'
import type { StructuredAgentSessionDeliveryPlace } from './structured-agent-session-delivery-order'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'

import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

import {
  operationDidNotRun,
  selectStructuredAgentSessionOperationChild,
  type ReadyOperationSelection
} from './structured-agent-session-operation-child'
export {
  openWithReadyStructuredAgentSessionChild,
  operationDidNotRun,
  type ReadyOperationChild,
  type ReadyOperationSelection
} from './structured-agent-session-operation-child'

type QueuedReadyOperation<T> =
  | { result: AgentSessionMutationResult<T> }
  | {
      /** null starts a child outside serialization. */
      child: StructuredAgentSessionProviderChildIdentity | null
      readiness: StructuredAgentSessionStartReadiness | null
      start: StructuredAgentSessionStartClaim | null
      place: StructuredAgentSessionDeliveryPlace
    }

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

/** Run ready operations in-lane; release serialization before awaiting startup/readiness. */
export async function runWithReadyStructuredAgentSessionOperation<T>(
  context: StructuredAgentSessionMutationContext,
  callerKey: string,
  envelope: AgentSessionMutationEnvelope,
  plan: ReadyOperationPlan<T>,
  run: (selection: ReadyOperationSelection) => Promise<AgentSessionMutationResult<T>>,
  options: {
    beforeAgent?: (row: AgentSessionRecord | null) => AgentSessionMutationSessionPreparation | null
    goal?: boolean
    needsAgent?: (record: AgentSessionRecord | null) => boolean
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
  let authority: ReturnType<typeof context.acquireAborts.begin> | undefined
  const preparedOperation = context.serialize<QueuedReadyOperation<T>>(
    envelope.sessionId,
    async () => {
      authority = options.goal
        ? context.acquireAborts.begin(envelope.sessionId, false, true)
        : undefined
      const record = context.deps.store.getRecord(envelope.sessionId)
      if (options.needsAgent && !options.needsAgent(record)) {
        return { result: await run({ ok: true, child: null }) }
      }
      if (plan.commandReceipt) {
        if (parseAgentSessionOperationTimestamp(envelope.clientOperationId) === null) {
          return { result: await run({ ok: true, child: null }) }
        }
        // Resolve receipt replay/unreadable results before any provider start.
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
          const turn = mutationReplayContext(request, journal, current.record)
          const answer = replayRecordedOperation(
            { envelope, plan: { ...plan, replay: plan.replay } },
            turn,
            current.decision.row
          )
          if (answer !== 'rerun') {
            return { result: await run({ ok: true, child: null, replay: true }) }
          }
        } else if (!evaluated || evaluated.decision.decision !== 'admit') {
          return { result: await run({ ok: true, child: null }) }
        }
      }
      try {
        context.deps.store.requireWritableRecord(envelope.sessionId)
      } catch (error) {
        if (isAgentSessionRefusalError(error)) {
          return { result: { ok: false as const, refusal: error.refusal } }
        }
        throw error
      }
      const select = async () => {
        const opened = await openForWrite(context, envelope)()
        if (!opened.ok) {
          return opened
        }
        const current = context.deps.store.requireWritableRecord(envelope.sessionId)
        const checked = options.beforeAgent?.(current)
        if (checked && !checked.ok) {
          return checked
        }
        return selectStructuredAgentSessionOperationChild(context, envelope.sessionId)
      }
      const child = await select().catch((error: unknown) => {
        if (isAgentSessionRefusalError(error)) {
          return { ok: false as const, refusal: error.refusal }
        }
        context.deps.logger.warn('selecting an agent for an operation failed', {
          scope: 'operation-agent-start',
          sessionId: envelope.sessionId,
          error
        })
        return operationDidNotRun()
      })
      if (authority?.signal.aborted) {
        return { result: operationDidNotRun() }
      }
      if (!child.ok) {
        return { result: child }
      }
      if (
        child.child &&
        !child.readiness &&
        !context.deliveryOrder.hasActiveSend(envelope.sessionId)
      ) {
        return {
          result: await run({ ok: true, child: child.child, deadline, signal: authority?.signal })
        }
      }
      context.deliveryOrder.reconcile(
        envelope.sessionId,
        context.sessions.get(envelope.sessionId)?.journal.submissions() ?? []
      )
      const place = context.deliveryOrder.reserve(envelope.sessionId)
      return {
        start: child.child ? null : context.claimAgent(envelope.sessionId),
        child: child.child,
        readiness: child.readiness,
        place
      }
    }
  )
  const selected = await preparedOperation.then(
    (selection) => {
      if ('result' in selection) {
        authority?.end()
      }
      return selection
    },
    (error: unknown) => {
      authority?.end()
      throw error
    }
  )
  if ('result' in selected) {
    return selected.result
  }
  try {
    let { child, readiness } = selected
    if (!child) {
      const start = selected.start?.outcome ?? Promise.resolve(undefined)
      const ready = start.then(() => 'ready' as const)
      const elapsed = waitForStructuredAgentSessionStart(ready, deadline - Date.now())
      const started = await waitForPromiseWithSignal(
        elapsed.then((ready) => (ready === 'ready' ? start : undefined)),
        authority?.signal
      ).catch((error: unknown) => {
        if (authority?.signal.aborted) {
          return undefined
        }
        throw error
      })
      if (!started?.ok) {
        return started ?? operationDidNotRun(!authority?.signal.aborted && Date.now() >= deadline)
      }
      const selection = selectStructuredAgentSessionOperationChild(context, envelope.sessionId)
      if (!selection.ok || !selection.child) {
        return selection.ok ? operationDidNotRun() : selection
      }
      child = selection.child
      readiness = selection.readiness
    }
    const ready = readiness?.wait() ?? Promise.resolve('ready' as const)
    const waiting = waitForStructuredAgentSessionStart(
      Promise.all([ready, selected.place.before]).then(([outcome]) =>
        outcome === 'ready' ? 'ready' : 'ended'
      ),
      deadline - Date.now()
    )
    const outcome = await waitForPromiseWithSignal(waiting, authority?.signal).catch(
      (error: unknown) => {
        if (authority?.signal.aborted) {
          return 'ended' as const
        }
        throw error
      }
    )
    if (outcome !== 'ready') {
      return operationDidNotRun(outcome === 'timeout')
    }
    if (Date.now() >= deadline) {
      return operationDidNotRun(true)
    }
    const ran = child
    return await context.serialize(envelope.sessionId, () =>
      // Re-read after readiness so competing settlement wins admission.
      run({ ok: true, child: ran, deadline, signal: authority?.signal })
    )
  } finally {
    authority?.end()
    selected.place.release()
  }
}
