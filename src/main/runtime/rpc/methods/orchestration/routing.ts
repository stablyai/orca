import type { MessageType } from '../../../orchestration/db'
import type { RunRow } from '../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationCallerIdentity } from '../../../orchestration/orchestration-caller-identity'
import { MESSAGE_TYPES } from '../../../orchestration/types'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../../../orchestration/db'
import { isDispatchMutationMessageType, parseMessageTaskId } from './schemas'

export function parseMessageTypes(rawTypes: string | undefined): MessageType[] | undefined {
  const types = rawTypes
    ?.split(',')
    .map((type) => type.trim())
    .filter(Boolean) as MessageType[] | undefined
  const invalidTypes = types?.filter((type) => !MESSAGE_TYPES.includes(type))
  if (invalidTypes && invalidTypes.length > 0) {
    throw new OrchestrationError('invalid_argument', `Invalid --types: ${invalidTypes.join(',')}`)
  }
  return types && types.length > 0 ? types : undefined
}

export function resolveMessageRun(
  runtime: OrcaRuntimeService,
  params: {
    /** The sender as Run binding and Dispatch identity see it. */
    sender: OrchestrationCallerIdentity
    to?: string
    runId?: string
    payload?: string
    type?: string
  }
): { run: RunRow | undefined; dispatchId: string | undefined } {
  const db = runtime.getOrchestrationDb()
  let dispatchId: string | undefined
  if (params.payload) {
    try {
      const payload: unknown = JSON.parse(params.payload)
      if (
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        typeof (payload as { dispatchId?: unknown }).dispatchId === 'string'
      ) {
        dispatchId = (payload as { dispatchId: string }).dispatchId
      }
    } catch {
      // Lifecycle validation owns malformed payload errors; routing simply cannot derive a Dispatch.
    }
  }
  const payloadNamesDispatch = dispatchId !== undefined
  if (!dispatchId && params.to?.startsWith('dispatch:')) {
    dispatchId = params.to.slice('dispatch:'.length)
  }

  const dispatch = dispatchId
    ? db.getDispatchContextById(dispatchId)
    : db.getActiveDispatchForIdentity(params.sender.address, params.sender.paneKey ?? undefined)
  if (params.to?.startsWith('dispatch:') && !dispatch) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${dispatchId ?? ''} was not found.`
    )
  }
  const targetRunId = params.to?.startsWith('run:') ? params.to.slice('run:'.length) : undefined
  for (const namedRunId of new Set([params.runId, targetRunId])) {
    if (namedRunId) {
      rejectRemotelyHomedRun(db, namedRunId)
    }
  }
  const resolvedRunId = params.runId ?? targetRunId ?? dispatch?.run_id
  let run = resolvedRunId ? db.getRun(resolvedRunId) : undefined

  if (!run) {
    run = db.getCurrentRunForCoordinator(params.sender)
  }
  if (resolvedRunId && (!run || run.legacy === 1)) {
    throw new OrchestrationError('run_not_found', `Run ${resolvedRunId} was not found.`)
  }
  if (run && targetRunId && targetRunId !== run.id) {
    throw new OrchestrationError('run_not_found', `Run ${targetRunId} was not found.`)
  }
  if (run && dispatch && dispatch.run_id !== run.id) {
    throw new OrchestrationError(
      'dispatch_run_mismatch',
      `Dispatch ${dispatch.id} belongs to Run ${dispatch.run_id}, not ${run.id}.`
    )
  }
  // Payload/lifecycle Dispatch scopes mail; lifecycle validation checks Task/Dispatch mismatch.
  if (
    run &&
    !params.to &&
    !params.runId &&
    !(dispatch && (payloadNamesDispatch || isDispatchMutationMessageType(params.type)))
  ) {
    const taskId = parseMessageTaskId(params.payload)
    const task = taskId ? db.getTask(taskId) : undefined
    // Nested coordinators reporting child-Run Tasks still reach their parent.
    const senderCoordinatesTaskRun =
      dispatch !== undefined &&
      task?.run_id != null &&
      db.runsBoundToCoordinator(params.sender).some((bound) => bound.id === task.run_id)
    if (task?.run_id && task.run_id !== run.id && !senderCoordinatesTaskRun) {
      // Offer Dispatch-bound senders only their own Run; another would fail dispatch_run_mismatch.
      const nextStep = dispatch
        ? `rerun with --run ${run.id} to send to your Dispatch ${dispatch.id}'s Run.`
        : `rerun with --run ${task.run_id} to reach the Task's Run, or --run ${run.id} to keep the inferred Run.`
      throw new OrchestrationError(
        'task_run_mismatch',
        `Task ${task.id} belongs to Run ${task.run_id}, not the inferred Run ${run.id}. Nothing was sent; ${nextStep}`
      )
    }
  }
  return { run, dispatchId: dispatch?.id ?? dispatchId }
}

export function legacyWorkerDeliveryContract(
  runtime: OrcaRuntimeService,
  runId: string | undefined,
  recipient: string
): 'legacy_direct' | undefined {
  if (!runId) {
    return undefined
  }
  if (!recipient.startsWith('dispatch:')) {
    return runtime
      .getOrchestrationDb()
      .resolveLegacyWorkerCandidate({ runId, terminalHandle: recipient })
      ? 'legacy_direct'
      : undefined
  }
  const dispatch = runtime
    .getOrchestrationDb()
    .getDispatchContextById(recipient.slice('dispatch:'.length))
  return dispatch?.run_id === runId &&
    dispatch.contract_version === LEGACY_CONTRACT_VERSION &&
    (dispatch.status === 'pending' || dispatch.status === 'dispatched')
    ? 'legacy_direct'
    : undefined
}

export function interruptedAcknowledgedCheck(
  runId: string,
  acknowledged: string,
  reason: 'consumer_fenced' | 'outcome_unknown'
): Record<string, unknown> {
  return {
    runId,
    deliveryId: null,
    messages: [],
    count: 0,
    acknowledged,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    waitInterrupted: reason
  }
}

/** Remote Run rows are local mirrors; mail stored there reaches nobody (#32292). */
export function rejectRemotelyHomedRun(
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  runId: string
): void {
  if (db.getRun(runId)?.home_database === 'remote') {
    throw remoteRunHomeUnreachable(db, runId)
  }
}

export function remoteRunHomeUnreachable(
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  runId: string
): OrchestrationError {
  const dispatchId = db.findRemoteAttachmentForHomeRun(runId)?.dispatch_id
  const detached = dispatchId
    ? `this terminal is no longer attached to its Dispatch ${dispatchId}`
    : 'this terminal is not attached to one of its Dispatches'
  return new OrchestrationError(
    'run_home_unreachable',
    `Run ${runId} lives on the computer that coordinates it, which isn't reachable from here: ${detached}. Nothing was sent.`
  )
}

/** A federated worker reaches only its Run home; naming that home is the same as omitting it. */
export function rejectFederatedExplicitTarget(
  params: { to?: string; run?: string },
  homeRunId: string
): void {
  const namesOnlyHome =
    (!params.to || params.to === `run:${homeRunId}`) && (!params.run || params.run === homeRunId)
  if (!namesOnlyHome) {
    throw new OrchestrationError(
      'invalid_argument',
      'Federated Dispatch messages route to their Run home; omit --to and --run.'
    )
  }
}
