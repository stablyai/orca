import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { EventsParams } from '../../../../../../shared/rpc-contract/orchestration-params'
import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../../../../../shared/orchestration/mailbox/orchestration-message-wait-timeout'
import { exposeUtcTimestamp } from '../../../../orchestration/db/utc-timestamp'
import {
  runWorkerStateEvent,
  type RunWorkerStateEvent
} from '../../../../orchestration/mailbox/run-event-observers'
import { resolveRunScope } from '../runs/run-scope'
import { callerHoldsDispatchPane, dispatchFenced } from './dispatch-mailbox-fence'

type RunEvent =
  | RunWorkerStateEvent
  | {
      type: 'message'
      cursor: string
      runId: string
      message: { id: string; type: string; from: string; subject: string; createdAt: string }
    }
  | { type: 'lost'; reason: 'cursor_unknown' }
  | { type: 'end'; reason: 'consumer_fenced' | 'run_closed' | 'dispatch_closed' }

// Cursor: message sequence, process epoch, worker-state journal position.
function parseCursor(cursor: string): { message: number; epoch: string; state: number } {
  const [message, epoch, state, extra] = cursor.split('.')
  const parsed = { message: Number(message), epoch: epoch ?? '', state: Number(state) }
  if (
    extra !== undefined ||
    !Number.isSafeInteger(parsed.message) ||
    !Number.isSafeInteger(parsed.state)
  ) {
    throw new OrchestrationError('invalid_argument', `Invalid --since cursor: ${cursor}`)
  }
  return parsed
}

export const ORCHESTRATION_EVENTS_METHODS = [
  defineMethod({
    name: 'orchestration.events',
    permission: 'workspace',
    params: EventsParams,
    handler: async (
      params,
      {
        runtime,
        signal,
        orchestrationCaller,
        legacyCoordinatorRunId,
        orchestrationCompatibilityEvidence
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const observers = runtime.runEventObservers
      const handle = params.terminal ?? 'unknown'
      const paneKey = runtime.getTerminalPaneKey(handle) ?? params.terminalPaneKey
      const wants = (type: 'message' | 'worker_state') =>
        !params.types || params.types.includes(type)

      const ownDispatch = db.getActiveDispatchForIdentity(handle, paneKey)
      // A worker sees only its own Dispatch's state, never the Run mailbox.
      const workerDispatch = ownDispatch?.run_id === params.runId ? ownDispatch : undefined
      if (workerDispatch && !callerHoldsDispatchPane(workerDispatch, paneKey)) {
        throw dispatchFenced()
      }
      const workerDispatchId = workerDispatch?.id
      const resolveCoordinatedRun = () =>
        resolveRunScope(runtime, {
          runId: params.runId,
          callerTerminalHandle: handle,
          callerPaneKey: paneKey,
          callerSession: orchestrationCaller,
          requireCurrentConsumer: true,
          legacyCoordinatorRunId,
          callerEvidence: orchestrationCompatibilityEvidence
        })
      const run = workerDispatchId ? db.getRun(params.runId)! : resolveCoordinatedRun()
      const generation = run.consumer_generation

      const endReason = (): 'consumer_fenced' | 'run_closed' | 'dispatch_closed' | null => {
        if (!db.getRun(run.id)) {
          return 'run_closed'
        }
        if (workerDispatchId) {
          const dispatch = db.getDispatchContextById(workerDispatchId)
          return dispatch &&
            (dispatch.status === 'pending' || dispatch.status === 'dispatched') &&
            callerHoldsDispatchPane(dispatch, paneKey)
            ? null
            : 'dispatch_closed'
        }
        try {
          return resolveCoordinatedRun().consumer_generation === generation
            ? null
            : 'consumer_fenced'
        } catch (error) {
          if (error instanceof OrchestrationError && error.code === 'consumer_fenced') {
            return 'consumer_fenced'
          }
          throw error
        }
      }

      const since = params.sinceCursor ? parseCursor(params.sinceCursor) : undefined
      const latestSequence = db.getLatestMessageSequence()
      const events: RunEvent[] = []
      // A cursor past every stored message came from another database or a reset.
      const lost = since !== undefined && since.message > latestSequence
      if (lost) {
        events.push({ type: 'lost', reason: 'cursor_unknown' })
      }
      let messageSequence = since && !lost ? since.message : latestSequence
      let stateSequence = since?.epoch === observers.epoch ? since.state : -1

      // State has no replay: a reader the journal cannot vouch for gets current states instead.
      const collectStates = (): void => {
        const changes = stateSequence >= 0 ? observers.statesSince(stateSequence) : undefined
        const cursor = observers.stateCursor
        if (!wants('worker_state')) {
          stateSequence = cursor
          return
        }
        if (changes) {
          for (const { sequence: _sequence, ...change } of changes) {
            if (
              change.runId === run.id &&
              (!workerDispatchId || change.dispatchId === workerDispatchId)
            ) {
              events.push(change)
            }
          }
        } else {
          for (const dispatch of db.getLiveRunDispatchPanes(run.id)) {
            const row = runtime.agentTransitions.latestRow(dispatch.assignee_pane_key)
            if (row && (!workerDispatchId || dispatch.id === workerDispatchId)) {
              events.push({
                ...runWorkerStateEvent(
                  run.id,
                  { dispatchId: dispatch.id, taskId: dispatch.task_id },
                  row
                ),
                snapshot: true
              })
            }
          }
        }
        stateSequence = cursor
      }
      const cursorAt = (message: number) => `${message}.${observers.epoch}.${stateSequence}`
      const collectMessages = (): void => {
        if (workerDispatchId || !wants('message')) {
          return
        }
        for (const row of db.getRunEventMessages(run, messageSequence)) {
          messageSequence = row.sequence
          events.push({
            type: 'message',
            cursor: cursorAt(row.sequence),
            runId: run.id,
            message: {
              id: row.id,
              type: row.type,
              from: row.from_handle,
              subject: row.subject,
              createdAt: exposeUtcTimestamp(row.created_at) ?? row.created_at
            }
          })
        }
      }

      const deadline =
        Date.now() + (params.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS)
      let seen = observers.wakeCount
      collectStates()
      collectMessages()
      // The first call returns at once so the reader holds a cursor before anything happens.
      while (since && events.length === 0) {
        if (!(await observers.waitAfter(seen, deadline - Date.now(), signal))) {
          break
        }
        seen = observers.wakeCount
        const reason = endReason()
        if (reason) {
          events.push({ type: 'end', reason })
          break
        }
        collectStates()
        collectMessages()
      }
      return { cursor: cursorAt(messageSequence), events }
    }
  })
]
