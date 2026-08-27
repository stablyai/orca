import { z } from 'zod'
import { COORDINATOR_WAKE_MESSAGE_TYPES } from '../../orchestration/control-plane/coordinator-wake-events'
import {
  AWAIT_DEFAULT_BUDGET_MS,
  AWAIT_MAX_BUDGET_MS,
  AWAIT_SWEEP_INTERVAL_MS,
  clampAwaitBudgetMs,
  resolveAwaitWakeEvents
} from '../../orchestration/control-plane/coordinator-await-contract'
import { runLivenessSweep } from '../../orchestration/control-plane/liveness-sweep'
import { driveRunPhaseLaunches } from './orchestration-phase-launch'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { MessageRow, MessageType } from '../../orchestration/types'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString } from '../schemas'

const AwaitParams = z.object({
  from: OptionalString,
  run: OptionalString,
  ack: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  sweepIntervalMs: OptionalFiniteNumber
})

/** B3/B4 (correction 2) — the durable, runtime-owned wait.
 *
 *  The coordinator calls this once and yields. Its lifetime is the runtime's
 *  budget (default 6h, max 24h), NOT a model continuation window: the internal
 *  `waitForMessage` slices exist only so the liveness sweep can run on its own
 *  clock, and a slice that times out is re-armed by the runtime without ever
 *  returning to the model. Only a real wake event ends the call early.
 *
 *  It wakes exclusively for the canonical set: WORKER_DONE, QUESTION,
 *  ESCALATION, and the typed STALLED / CRASHED / REVIEW_COMPLETE / CI_BLOCKER
 *  escalations. `orchestration.check --wait` is untouched and still works.
 */
export const ORCHESTRATION_AWAIT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.await',
    params: AwaitParams,
    handler: async (params, { runtime, signal }) => {
      const db = runtime.getOrchestrationDb()
      const handle = params.from ?? 'unknown'
      const paneKey = runtime.getTerminalPaneKey(handle) ?? undefined
      const boundRun = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
      const runId = params.run ?? boundRun?.id
      if (!runId) {
        throw new OrchestrationError(
          'run_not_bound',
          'orchestration.await requires a bound coordinator Run; bind one with run-use.'
        )
      }
      const run = db.getRun(runId)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${runId} was not found.`)
      }
      const generation = run.consumer_generation
      const address = `run:${run.id}`
      const wakeTypes = [...COORDINATOR_WAKE_MESSAGE_TYPES] as MessageType[]

      if (params.ack) {
        db.acknowledgeRunDelivery({
          runId: run.id,
          consumerGeneration: generation,
          deliveryId: params.ack
        })
      }

      const budgetMs = clampAwaitBudgetMs(params.timeoutMs)
      const sliceMs = Math.max(
        1_000,
        Math.min(params.sweepIntervalMs ?? AWAIT_SWEEP_INTERVAL_MS, budgetMs)
      )
      const deadline = Date.now() + budgetMs
      const source = runtime.getOrchestrationLivenessSignalSource()

      const readDelivery = ():
        | { deliveryId: string; messages: MessageRow[]; replayed: boolean }
        | undefined => {
        const current = db.getOrCreateRunDelivery({
          runId: run.id,
          consumerGeneration: generation,
          wakeTypes
        })
        return current
          ? {
              deliveryId: current.delivery.id,
              messages: current.messages,
              replayed: current.replayed
            }
          : undefined
      }

      let sweeps = 0
      for (;;) {
        // Why the sweep first: a Dispatch that stalled or crashed while nobody
        // was subscribed must surface on the first tick, not only on the next
        // message that happens to arrive.
        const sweep = await runLivenessSweep({
          db,
          runId: run.id,
          source,
          publisher: runtime,
          nowMs: Date.now()
        })
        // Why on the same tick: this is the runtime loop that owns the Run, so a
        // reviewer or correction phase planned by a completion starts here with
        // no human step. The driver is idempotent, so re-running is free.
        await driveRunPhaseLaunches({ runtime, ctx: { runtime, signal }, runId: run.id })
        sweeps += 1
        const delivery = readDelivery()
        if (delivery) {
          const wakeEvents = resolveAwaitWakeEvents(delivery.messages)
          // Why a replayed non-wake Delivery still returns: the Delivery
          // protocol allows exactly one outstanding batch, so an unacked batch
          // from a previous `check` would otherwise starve this subscription
          // forever. It comes back flagged, not disguised as a wake.
          return {
            runId: run.id,
            ...delivery,
            count: delivery.messages.length,
            wakeEvents,
            pendingAck: wakeEvents.length === 0,
            sweeps,
            livenessWakes: sweep.wakes,
            timedOut: false,
            cancelled: false,
            budgetMs
          }
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          return {
            runId: run.id,
            deliveryId: null,
            messages: [],
            count: 0,
            wakeEvents: [],
            sweeps,
            livenessWakes: [],
            timedOut: true,
            cancelled: false,
            budgetMs
          }
        }
        const waitResult = await runtime.waitForMessage(address, {
          typeFilter: wakeTypes as string[],
          timeoutMs: Math.min(sliceMs, remainingMs),
          signal,
          // Why exclusive: a Run has exactly one actionable consumer, the same
          // invariant `check --wait` enforces. Two subscriptions would both be
          // handed the same Delivery and race the acknowledgement.
          exclusive: true
        })
        if (waitResult === 'waiter_exists') {
          throw new OrchestrationError(
            'waiter_exists',
            `Run ${run.id} already has an active actionable waiter.`
          )
        }
        if (waitResult === 'cancelled') {
          return {
            runId: run.id,
            deliveryId: null,
            messages: [],
            count: 0,
            wakeEvents: [],
            sweeps,
            livenessWakes: [],
            timedOut: false,
            cancelled: true,
            connectionLost: signal?.aborted === true,
            budgetMs
          }
        }
        // Why no early return on 'timed_out': a slice timeout is not a wake
        // event. The runtime re-arms and keeps the subscription alive.
      }
    }
  })
]

export { AWAIT_DEFAULT_BUDGET_MS, AWAIT_MAX_BUDGET_MS }
