/* eslint-disable max-lines -- Why: RPC method definitions co-locate param schemas with handlers; splitting by method would scatter the shared enums and Zod transforms without reducing complexity. */
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, OptionalBoolean, requiredString } from '../schemas'
import {
  LEGACY_CONTRACT_VERSION,
  type MessageType,
  type MessagePriority,
  type TaskStatus
} from '../../orchestration/db'
import { MESSAGE_TYPES } from '../../orchestration/types'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { formatMessageBanner } from '../../orchestration/formatter'
import { isGroupAddress, resolveGroupAddress } from '../../orchestration/groups'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import { abbreviateOrchestrationTasks } from '../../../../shared/orchestration-task-summary'
import {
  ORCHESTRATION_LEGACY_RUN_ID,
  orchestrationSkillRecoveryData
} from '../../../../shared/orchestration-rpc-contract'
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import { ORCHESTRATION_GATE_METHODS } from './orchestration-gates'
import { resolveRunScope } from './orchestration-run-scope'
import { ORCHESTRATION_RUN_METHODS } from './orchestration-runs'
import { ORCHESTRATION_WORKER_METHODS } from './orchestration-worker-methods'
import { ORCHESTRATION_FEDERATION_METHODS } from './orchestration-federation-methods'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RunRow } from '../../orchestration/types'
import { encodeFederatedControlMessage } from '../../orchestration/federation-control-message'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../shared/protocol-version'

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
]

function getLifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

function parseRemoteWorkerPayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new OrchestrationError('invalid_argument', 'Message payload must be valid JSON.')
  }
}

function isWorkerReportOutcome(value: unknown): value is 'succeeded' | 'failed' {
  return value === 'succeeded' || value === 'failed'
}

const SendParams = z
  .object({
    to: OptionalString,
    subject: requiredString('Missing --subject'),
    from: OptionalString,
    body: OptionalString,
    type: z
      .enum([
        'status',
        'dispatch',
        'worker_done',
        'merge_ready',
        'escalation',
        'handoff',
        'decision_gate',
        'question',
        'heartbeat'
      ])
      .optional(),
    priority: z.enum(['normal', 'high', 'urgent']).optional(),
    threadId: OptionalString,
    payload: OptionalString,
    // Why: pane key is the remint-stable identity used to verify worker_done/heartbeat ownership; the from handle stays routing metadata.
    senderPaneKey: OptionalString,
    run: OptionalString,
    devMode: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    if (
      (params.type !== 'worker_done' && params.type !== 'heartbeat') ||
      !params.to ||
      !isGroupAddress(params.to)
    ) {
      return
    }
    // Why: dispatch lifecycle messages are authority/liveness signals for one coordinator; fanout would create lifecycle mail in unrelated terminals.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: getLifecycleGroupRecipientError(params.type),
      path: ['to']
    })
  })

const CheckParams = z
  .object({
    terminal: OptionalString,
    terminalPaneKey: OptionalString,
    unread: OptionalBoolean,
    peek: OptionalBoolean,
    // Why: `all` surfaces every message and skips mark-read; legacy encoding was the `{unread: false}` trick (design doc §3.2/§3.3).
    all: OptionalBoolean,
    types: OptionalString,
    format: OptionalBoolean,
    // Why: one-release RPC compatibility only; the public CLI uses --format because no terminal input is injected.
    inject: OptionalBoolean,
    ack: OptionalString,
    compatibilityAck: OptionalString,
    compatibilityQuestionAck: OptionalString,
    compatibilityCliCommand: z.enum(['orca', 'orca-ide', 'orca-dev']).optional(),
    run: OptionalString,
    wait: OptionalBoolean,
    timeoutMs: OptionalFiniteNumber
  })
  .superRefine((params, ctx) => {
    // Why: CLI encodes --peek as {peek:true, unread:false} for pre-peek runtimes, so that pair is one mode, not a conflict.
    const modes = [
      params.unread === true,
      params.peek === true,
      params.all === true || (params.unread === false && params.peek !== true)
    ].filter(Boolean)
    if (modes.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose at most one message read mode: --unread, --peek, or --all.'
      })
    }
  })

const ReplyParams = z.object({
  id: requiredString('Missing --id'),
  body: requiredString('Missing --body'),
  from: OptionalString,
  run: OptionalString
})

const InboxParams = z.object({
  limit: OptionalFiniteNumber,
  // Why: filters the inbox to a handle so inbox and check --all give agreeing results (design doc §3.3).
  terminal: OptionalString
})

const TaskCreateParams = z.object({
  spec: requiredString('Missing --spec'),
  taskTitle: OptionalString,
  displayName: OptionalString,
  deps: OptionalString,
  parent: OptionalString,
  callerTerminalHandle: OptionalString,
  run: OptionalString
})

const TaskListParams = z.object({
  status: z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']).optional(),
  ready: OptionalBoolean,
  // Why: server-side truncation keeps --brief cheap over SSH/relay instead of shipping full specs the CLI throws away.
  brief: OptionalBoolean,
  run: OptionalString,
  callerTerminalHandle: OptionalString
})

const TaskUpdateParams = z.object({
  id: requiredString('Missing --id'),
  status: z
    .unknown()
    .transform((v) => {
      if (typeof v === 'string' && TASK_STATUSES.includes(v as TaskStatus)) {
        return v as TaskStatus
      }
      return ''
    })
    .pipe(
      z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'], {
        message: 'Missing --status'
      })
    ),
  result: OptionalString,
  run: OptionalString,
  callerTerminalHandle: OptionalString
})

const DispatchParams = z.object({
  task: requiredString('Missing --task'),
  // Why: --to is optional so --dry-run can preview without a target; the handler enforces presence before any side-effecting work.
  to: OptionalString,
  from: OptionalString,
  inject: OptionalBoolean,
  dryRun: OptionalBoolean,
  returnPreamble: OptionalBoolean,
  devMode: OptionalBoolean,
  run: OptionalString
})

const DispatchShowParams = z.object({
  task: OptionalString,
  preamble: OptionalBoolean,
  from: OptionalString,
  devMode: OptionalBoolean
})

const AskParams = z
  .object({
    to: OptionalString,
    question: OptionalString,
    resume: OptionalString,
    options: OptionalString,
    timeoutMs: OptionalFiniteNumber,
    from: OptionalString,
    run: OptionalString,
    compatibilityCliCommand: z.enum(['orca', 'orca-ide', 'orca-dev']).optional(),
    compatibilityWindowsCommand: z.enum(['orca', 'orca-ide']).optional()
  })
  .superRefine((params, ctx) => {
    if ((params.question ? 1 : 0) + (params.resume ? 1 : 0) !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one of --question or --resume.'
      })
    }
  })

const ResetParams = z
  .object({
    all: OptionalBoolean,
    tasks: OptionalBoolean,
    messages: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    const selectedScopeCount = [params.all, params.tasks, params.messages].filter(
      (scope) => scope === true
    ).length
    if (selectedScopeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
      })
    }
  })

function parseMessageTypes(rawTypes: string | undefined): MessageType[] | undefined {
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

function resolveMessageRun(
  runtime: OrcaRuntimeService,
  params: {
    from?: string
    senderPaneKey?: string
    to?: string
    runId?: string
    payload?: string
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
  if (!dispatchId && params.to?.startsWith('dispatch:')) {
    dispatchId = params.to.slice('dispatch:'.length)
  }

  const dispatch = dispatchId
    ? db.getDispatchContextById(dispatchId)
    : params.from
      ? db.getActiveDispatchForIdentity(params.from, params.senderPaneKey)
      : undefined
  if (params.to?.startsWith('dispatch:') && !dispatch) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${dispatchId ?? ''} was not found.`
    )
  }
  const targetRunId = params.to?.startsWith('run:') ? params.to.slice('run:'.length) : undefined
  const resolvedRunId = params.runId ?? targetRunId ?? dispatch?.run_id
  let run = resolvedRunId ? db.getRun(resolvedRunId) : undefined

  if (!run && params.from) {
    const paneKey = params.senderPaneKey ?? runtime.getTerminalPaneKey(params.from)
    run = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
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
  return { run, dispatchId: dispatch?.id ?? dispatchId }
}

function legacyWorkerDeliveryContract(
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

function interruptedAcknowledgedCheck(
  runId: string,
  acknowledged: string,
  reason: 'consumer_fenced' | 'outcome_unknown' | 'waiter_exists'
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

function rejectFederatedExplicitTarget(params: { to?: string; run?: string }): void {
  if (params.to || params.run) {
    throw new OrchestrationError(
      'invalid_argument',
      'Federated Dispatch messages route to their Run home; omit --to and --run.'
    )
  }
}

export const ORCHESTRATION_METHODS: RpcMethod[] = [
  ...ORCHESTRATION_RUN_METHODS,
  ...ORCHESTRATION_WORKER_METHODS,
  ...ORCHESTRATION_FEDERATION_METHODS,
  defineMethod({
    name: 'orchestration.send',
    params: SendParams,
    handler: async (
      params,
      {
        runtime,
        orchestrationCapability,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        orchestrationCompatibilityCallerAuthority
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      const attestedCaller =
        orchestrationCompatibilityCallerAuthority?.terminalHandle === from
          ? orchestrationCompatibilityCallerAuthority
          : undefined
      // Why: attested hook identity survives graph remount; caller params never supply lifecycle authority.
      const senderPaneKey = attestedCaller?.paneKey ?? runtime.getTerminalPaneKey(from) ?? undefined
      const remoteAttachment = senderPaneKey
        ? db.findActiveRemoteAttachmentForPane(senderPaneKey)
        : undefined
      if (remoteAttachment) {
        rejectFederatedExplicitTarget(params)
        const processIncarnation =
          attestedCaller?.processIncarnation ?? runtime.getTerminalProcessIncarnation(from)
        if (
          !db.verifyRemoteAttachmentAuthority({
            dispatchId: remoteAttachment.dispatch_id,
            capability: orchestrationCapability,
            paneKey: senderPaneKey ?? null,
            processIncarnation
          })
        ) {
          throw new OrchestrationError(
            'dispatch_capability_invalid',
            'The remote Dispatch capability or exact worker process is invalid.'
          )
        }
        const type = (params.type ?? 'status') as MessageType
        const payload = parseRemoteWorkerPayload(params.payload)
        if (
          typeof payload.dispatchId === 'string' &&
          payload.dispatchId !== remoteAttachment.dispatch_id
        ) {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Dispatch ${payload.dispatchId} is not the active remote Dispatch for this pane.`
          )
        }
        const outcome =
          type === 'worker_done' &&
          (payload.outcome === 'succeeded' || payload.outcome === 'failed')
            ? payload.outcome
            : undefined
        if (type === 'worker_done' && !outcome) {
          throw new OrchestrationError(
            'invalid_argument',
            'Remote worker_done requires outcome=succeeded|failed.'
          )
        }
        const relay = db.enqueueFederationRelay({
          dispatchId: remoteAttachment.dispatch_id,
          direction: 'to_home',
          kind: type,
          payload: JSON.stringify({
            from,
            subject: params.subject,
            body: params.body ?? '',
            type,
            priority: params.priority ?? 'normal',
            threadId: params.threadId ?? null,
            payload: params.payload ?? null
          }),
          settleRemoteOutcome: outcome
        })
        return {
          relay: {
            messageId: relay.message_id,
            sequence: relay.sequence,
            dispatchId: relay.dispatch_id,
            destination: 'run_home',
            accepted: true
          },
          ...(outcome
            ? { lifecycle: { action: outcome === 'succeeded' ? 'completed' : 'failed' } }
            : {})
        }
      }
      const routing = resolveMessageRun(runtime, {
        from,
        senderPaneKey,
        to: params.to,
        runId: params.run,
        payload: params.payload
      })
      if (
        params.type === 'worker_done' &&
        !isWorkerReportOutcome(parseRemoteWorkerPayload(params.payload).outcome)
      ) {
        throw new OrchestrationError(
          'invalid_argument',
          'worker_done requires outcome=succeeded|failed for a current Dispatch.'
        )
      }
      if (params.to?.startsWith('task:')) {
        throw new OrchestrationError(
          'invalid_argument',
          'Task recipients are intentionally unsupported; use run:<id> or dispatch:<id>.'
        )
      }
      let to = params.to
      if (
        routing.run &&
        (!to ||
          ((params.type === 'worker_done' || params.type === 'heartbeat') && routing.dispatchId))
      ) {
        to = `run:${routing.run.id}`
      }
      if (!to) {
        throw new OrchestrationError(
          'run_required',
          'No recipient or active Dispatch Run could be resolved. No effects were applied.',
          orchestrationSkillRecoveryData()
        )
      }

      if (!isGroupAddress(to)) {
        const federatedDispatchId = routing.dispatchId
        const federatedTarget =
          federatedDispatchId && to === `dispatch:${federatedDispatchId}`
            ? db.getFederatedDispatch(federatedDispatchId)
            : undefined
        if (federatedTarget && federatedDispatchId) {
          const dispatchId = federatedDispatchId
          if (
            federatedTarget.protocol_version <
            ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
          ) {
            throw new OrchestrationError(
              'capability_unsupported',
              `Federated Dispatch ${dispatchId} does not support coordinator control mail; start a fresh worker after updating its Orca server.`
            )
          }
          if (db.getWorkerDispatch(dispatchId)?.state !== 'ready') {
            throw new OrchestrationError(
              'dispatch_inactive',
              `Federated Dispatch ${dispatchId} is not active.`
            )
          }
          if (params.type === 'worker_done' || params.type === 'heartbeat') {
            throw new OrchestrationError(
              'invalid_argument',
              'Coordinator-to-worker control mail cannot report worker lifecycle.'
            )
          }
          revalidateLegacyCoordinator?.()
          const relay = db.enqueueFederationRelay({
            dispatchId,
            direction: 'to_worker',
            kind: 'control_message',
            payload: encodeFederatedControlMessage({
              from,
              subject: params.subject,
              body: params.body ?? '',
              type: (params.type ?? 'status') as MessageType,
              priority: (params.priority ?? 'normal') as MessagePriority,
              threadId: params.threadId ?? null,
              payload: params.payload ?? null
            })
          })
          runtime.ensureOrchestrationFederationRelay(routing.run?.id)
          return {
            relay: {
              messageId: relay.message_id,
              sequence: relay.sequence,
              dispatchId: relay.dispatch_id,
              destination: 'worker',
              accepted: true
            }
          }
        }
        // Point-to-point — existing single-recipient behavior
        revalidateLegacyCoordinator?.()
        const msg = db.insertMessage({
          from,
          to,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId: params.threadId,
          payload: params.payload,
          senderPaneKey,
          runId: routing.run?.id,
          deliveryContract: legacyWorkerDeliveryContract(
            runtime,
            routing.run?.id ?? legacyCoordinatorRunId,
            to
          )
        })
        const dispatch = routing.dispatchId
          ? db.getDispatchContextById(routing.dispatchId)
          : undefined
        if ((msg.type === 'worker_done' || msg.type === 'heartbeat') && dispatch?.capability_hash) {
          const authority = db.verifyDispatchCapability({
            dispatchId: dispatch.id,
            capability: orchestrationCapability,
            paneKey: senderPaneKey,
            processIncarnation:
              attestedCaller?.processIncarnation ??
              runtime.getTerminalProcessIncarnation(from) ??
              undefined
          })
          if (!authority.valid) {
            const rejection =
              db.convertLifecycleMessageToRejection(
                msg.id,
                'dispatch_capability_invalid',
                authority.reason
              ) ?? msg
            runtime.notifyMessageArrived(to, rejection.type)
            return {
              message: rejection,
              lifecycle: {
                action: 'rejected',
                code: 'dispatch_capability_invalid',
                reason: authority.reason
              }
            }
          }
        }
        // Why: reconcile releases the dispatch lock before waking recipients, else a woken coordinator re-dispatches while the lock is still held.
        if (msg.type === 'worker_done' || msg.type === 'heartbeat') {
          const reconciled = reconcileLifecycleMessage(db, msg)
          // Why: a suppressed message is already read, so skip the notify that would wake a check --wait waiter to an empty result.
          if (reconciled.action === 'suppressed') {
            return { message: msg }
          }
          if (reconciled.action === 'rejected') {
            const rejection = db.getMessageById(msg.id) ?? msg
            runtime.notifyMessageArrived(to, rejection.type)
            return { message: rejection, lifecycle: reconciled }
          }
        }
        runtime.notifyMessageArrived(to, msg.type)
        return { message: msg }
      }

      // Why: fan out one message per recipient (independent read-tracking) but share a thread_id for correlation (Section 4.5).
      const { terminals } = await runtime.listTerminals()
      const handles = resolveGroupAddress(to, from, terminals, (handle: string) =>
        runtime.getAgentStatusForHandle(handle)
      )

      if (handles.length === 0) {
        throw new Error(`No recipients resolved for group address: ${to}`)
      }

      revalidateLegacyCoordinator?.()
      const threadId = params.threadId ?? `thread_${Date.now()}`
      const messages = handles.map((handle) =>
        db.insertMessage({
          from,
          to: handle,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId,
          payload: params.payload,
          senderPaneKey,
          runId: routing.run?.id,
          deliveryContract: legacyWorkerDeliveryContract(
            runtime,
            routing.run?.id ?? legacyCoordinatorRunId,
            handle
          )
        })
      )
      for (const message of messages) {
        runtime.notifyMessageArrived(message.to_handle, message.type)
      }

      return { messages, recipients: handles.length }
    }
  }),

  defineMethod({
    name: 'orchestration.check',
    params: CheckParams,
    handler: async (
      params,
      {
        orchestrationCompatibilityEvidence,
        runtime,
        signal,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        recordMutationReceipt
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const handle = params.terminal ?? 'unknown'
      const typeFilter = parseMessageTypes(params.types)

      // Why: a live runtime handle is authoritative; pane metadata is only the restart fallback.
      const paneKey = runtime.getTerminalPaneKey(handle) ?? params.terminalPaneKey
      const boundRun = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
      if (params.run || boundRun) {
        const run = resolveRunScope(runtime, {
          runId: params.run,
          callerTerminalHandle: handle,
          callerPaneKey: paneKey ?? undefined,
          requireCurrentConsumer: true,
          legacyCoordinatorRunId,
          callerEvidence: orchestrationCompatibilityEvidence
        })
        const generation = run.consumer_generation
        const address = `run:${run.id}`
        runtime.ensureOrchestrationFederationRelay(run.id)

        const acknowledged = params.ack
          ? db.acknowledgeRunDelivery({
              runId: run.id,
              consumerGeneration: generation,
              deliveryId: params.ack
            })
          : undefined
        if (acknowledged) {
          recordMutationReceipt?.(
            interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'outcome_unknown')
          )
        }
        if (params.peek || params.all || params.unread === false) {
          const history = db.getRunMailboxHistory(run.id, 100, typeFilter)
          const messages =
            params.all || (params.unread === false && !params.peek)
              ? history
              : history.filter((message) => message.read === 0)
          const result = {
            messages,
            count: messages.length,
            acknowledged: acknowledged?.delivery.id ?? null
          }
          if (params.format || params.inject) {
            return {
              ...result,
              formatted: messages.map(formatMessageBanner).join('\n\n'),
              runId: run.id
            }
          }
          return { ...result, runId: run.id }
        }

        const readDelivery = (wakeTypes?: MessageType[]) =>
          db.getOrCreateRunDelivery({
            runId: run.id,
            consumerGeneration: generation,
            wakeTypes
          })
        let current = readDelivery(params.wait ? typeFilter : undefined)
        if (current) {
          return {
            runId: run.id,
            deliveryId: current.delivery.id,
            messages: current.messages,
            count: current.messages.length,
            replayed: current.replayed,
            acknowledged: acknowledged?.delivery.id ?? null,
            timedOut: false,
            cancelled: false,
            connectionLost: false,
            ...(params.format || params.inject
              ? { formatted: current.messages.map(formatMessageBanner).join('\n\n') }
              : {})
          }
        }
        if (!params.wait) {
          return {
            runId: run.id,
            deliveryId: null,
            messages: [],
            count: 0,
            acknowledged: acknowledged?.delivery.id ?? null,
            timedOut: false,
            cancelled: false,
            connectionLost: false
          }
        }

        const waitResult = await runtime.waitForMessage(address, {
          typeFilter: typeFilter as string[] | undefined,
          timeoutMs: params.timeoutMs ?? undefined,
          signal,
          exclusive: true
        })
        try {
          revalidateLegacyCoordinator?.()
        } catch (error) {
          if (!acknowledged) {
            throw error
          }
          return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'consumer_fenced')
        }
        const latestRun = db.getRun(run.id)
        if (!latestRun || latestRun.consumer_generation !== generation) {
          if (acknowledged) {
            return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'consumer_fenced')
          }
          throw new OrchestrationError(
            'consumer_fenced',
            'This mailbox consumer was replaced while waiting.'
          )
        }
        if (waitResult === 'waiter_exists') {
          if (acknowledged) {
            return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'waiter_exists')
          }
          throw new OrchestrationError(
            'waiter_exists',
            `Run ${run.id} already has an active actionable waiter.`
          )
        }
        if (waitResult === 'timed_out') {
          return {
            runId: run.id,
            deliveryId: null,
            messages: [],
            count: 0,
            acknowledged: acknowledged?.delivery.id ?? null,
            timedOut: true,
            cancelled: false,
            connectionLost: false
          }
        }
        if (waitResult === 'cancelled') {
          return {
            runId: run.id,
            deliveryId: null,
            messages: [],
            count: 0,
            acknowledged: acknowledged?.delivery.id ?? null,
            timedOut: false,
            cancelled: true,
            connectionLost: signal?.aborted === true
          }
        }

        current = readDelivery(typeFilter)
        return {
          runId: run.id,
          deliveryId: current?.delivery.id ?? null,
          messages: current?.messages ?? [],
          count: current?.messages.length ?? 0,
          replayed: current?.replayed ?? false,
          acknowledged: acknowledged?.delivery.id ?? null,
          timedOut: false,
          cancelled: false,
          connectionLost: false,
          ...(params.format && current
            ? { formatted: current.messages.map(formatMessageBanner).join('\n\n') }
            : {})
        }
      }

      const activeDispatch = db.getActiveDispatchForIdentity(handle, paneKey ?? undefined)
      const remoteAttachment =
        !activeDispatch && paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
      if (
        remoteAttachment &&
        !db.isRemoteAttachmentProcessCurrent({
          dispatchId: remoteAttachment.dispatch_id,
          paneKey: paneKey ?? null,
          processIncarnation: runtime.getTerminalProcessIncarnation(handle)
        })
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${remoteAttachment.dispatch_id} is no longer attached to this worker process.`
        )
      }
      const workerMailbox = activeDispatch
        ? { dispatchId: activeDispatch.id, runId: activeDispatch.run_id }
        : remoteAttachment
          ? { dispatchId: remoteAttachment.dispatch_id, runId: undefined }
          : undefined
      if (workerMailbox) {
        const address = `dispatch:${workerMailbox.dispatchId}`
        const showAll = params.all === true || (params.unread === false && params.peek !== true)
        const messages = showAll
          ? db.getAllMessagesForHandle(address, 100, typeFilter)
          : db.getUnreadMessages(address, typeFilter)
        if (!showAll && params.peek !== true && messages.length > 0) {
          db.markAsRead(messages.map((message) => message.id))
        }
        if (messages.length > 0 || !params.wait) {
          return {
            ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
            dispatchId: workerMailbox.dispatchId,
            messages,
            count: messages.length,
            ...(params.format || params.inject
              ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
              : {})
          }
        }
        const waitResult = await runtime.waitForMessage(address, {
          typeFilter: typeFilter as string[] | undefined,
          timeoutMs: params.timeoutMs ?? undefined,
          signal
        })
        if (waitResult === 'timed_out' || waitResult === 'cancelled') {
          return {
            ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
            dispatchId: workerMailbox.dispatchId,
            messages: [],
            count: 0,
            timedOut: waitResult === 'timed_out',
            cancelled: waitResult === 'cancelled',
            connectionLost: waitResult === 'cancelled' && signal?.aborted === true
          }
        }
        const arrived = db.getUnreadMessages(address, typeFilter)
        db.markAsRead(arrived.map((message) => message.id))
        return {
          ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
          dispatchId: workerMailbox.dispatchId,
          messages: arrived,
          count: arrived.length,
          ...(params.format || params.inject
            ? { formatted: arrived.map(formatMessageBanner).join('\n\n') }
            : {})
        }
      }

      // Why: unread:false is honored for one release as a compat shim so in-flight callers don't break (design doc §5).
      const showAll = params.all === true || (params.unread === false && params.peek !== true)
      const consumeUnread = !showAll && params.peek !== true

      const readAndReturn = () => {
        const messages = showAll
          ? db.getAllMessagesForHandle(handle, undefined, typeFilter)
          : db.getUnreadMessages(handle, typeFilter)

        if (
          consumeUnread &&
          messages.some((message) => message.run_id === ORCHESTRATION_LEGACY_RUN_ID)
        ) {
          throw new OrchestrationError(
            'legacy_read_only',
            'Legacy orchestration messages are inspect-only; use --peek or --all. No acknowledgment was applied.',
            { effectsApplied: false }
          )
        }

        let visibleMessages = messages
        if (consumeUnread && messages.length > 0) {
          // Why: unread check is an authoritative read path for worker_done/heartbeat, so reconcile lifecycle messages here too.
          visibleMessages = messages.map((message) => {
            const reconciled = reconcileLifecycleMessage(db, message)
            return reconciled.action === 'rejected'
              ? (db.getMessageById(message.id) ?? message)
              : message
          })
          db.markAsRead(messages.map((m) => m.id))
        }

        if (params.format || params.inject) {
          const formatted = visibleMessages.map(formatMessageBanner).join('\n\n')
          return { messages: visibleMessages, formatted, count: visibleMessages.length }
        }

        return { messages: visibleMessages, count: visibleMessages.length }
      }

      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      const result = readAndReturn()
      if (result.count > 0 || !params.wait) {
        return result
      }

      // Why: signal aborts this waiter when the client socket closes, freeing the long-poll slot immediately rather than after timeoutMs (design doc §3.1).
      await runtime.waitForMessage(handle, {
        typeFilter: typeFilter as string[] | undefined,
        timeoutMs: params.timeoutMs ?? undefined,
        signal
      })
      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      return readAndReturn()
    }
  }),

  defineMethod({
    name: 'orchestration.reply',
    params: ReplyParams,
    handler: async (
      params,
      { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      const original = db.getMessageById(params.id)
      if (!original) {
        throw new Error(`Message not found: ${params.id}`)
      }
      if (
        legacyCoordinatorRunId &&
        (original.run_id !== legacyCoordinatorRunId ||
          (params.run !== undefined && params.run !== legacyCoordinatorRunId))
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Message ${params.id} does not belong to this adopted Run.`,
          { effectsApplied: false }
        )
      }
      if (
        original.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
        original.delivery_contract === 'legacy_direct' ||
        original.delivery_contract === 'audit_only'
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy orchestration messages are inspect-only; no reply was applied.',
          { effectsApplied: false }
        )
      }

      const question = db.getQuestion(params.id)
      if (question) {
        const run = resolveRunScope(runtime, {
          runId: params.run ?? question.run_id,
          callerTerminalHandle: params.from,
          requireCurrentConsumer: true,
          legacyCoordinatorRunId,
          callerEvidence: orchestrationCompatibilityEvidence
        })
        const answered = db.answerQuestion({
          messageId: question.message_id,
          runId: run.id,
          consumerGeneration: run.consumer_generation,
          body: params.body
        })
        const federated = db.getFederatedDispatch(question.dispatch_id)
        if (federated) {
          db.enqueueFederationRelay({
            dispatchId: question.dispatch_id,
            direction: 'to_worker',
            kind: 'reply',
            payload: JSON.stringify({
              questionId: question.message_id,
              answerMessageId: answered.message.id,
              body: params.body
            })
          })
          runtime.ensureOrchestrationFederationRelay(run.id)
        } else {
          runtime.notifyMessageArrived(`dispatch:${question.dispatch_id}`, 'status')
        }
        return {
          message: answered.message,
          question: answered.question,
          duplicate: answered.duplicate
        }
      }

      db.markAsRead([original.id])

      const reply = db.insertMessage({
        from: params.from ?? original.to_handle,
        to: original.from_handle,
        subject: `Re: ${original.subject}`,
        body: params.body,
        threadId: original.thread_id ?? original.id,
        runId: original.run_id
      })

      runtime.notifyMessageArrived(original.from_handle, reply.type)
      return { message: reply }
    }
  }),

  defineMethod({
    name: 'orchestration.inbox',
    params: InboxParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: stale/unknown handles return empty rather than error — historical rows survive handle deletion (design doc §3.3).
      const messages = params.terminal
        ? db.getAllMessagesForHandle(params.terminal, params.limit)
        : db.getInbox(params.limit)
      return { messages, count: messages.length }
    }
  }),

  defineMethod({
    name: 'orchestration.taskCreate',
    params: TaskCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      let deps: string[] | undefined
      if (params.deps) {
        try {
          const parsed = JSON.parse(params.deps)
          if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === 'string')) {
            throw new Error('not an array of strings')
          }
          deps = parsed
        } catch {
          throw new Error('Invalid --deps: must be a JSON array of task IDs')
        }
      }
      const task = db.createTask({
        spec: params.spec,
        taskTitle: params.taskTitle,
        displayName: params.displayName,
        deps,
        parentId: params.parent,
        createdByTerminalHandle: params.callerTerminalHandle,
        runId: resolveRunScope(runtime, {
          runId: params.run,
          callerTerminalHandle: params.callerTerminalHandle,
          requireCurrentConsumer: true,
          legacyCoordinatorRunId,
          callerEvidence: orchestrationCompatibilityEvidence
        }).id
      })
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.taskList',
    params: TaskListParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const explicitRun = params.run ? db.getRun(params.run) : undefined
      const run =
        explicitRun?.legacy === 1
          ? explicitRun
          : resolveRunScope(runtime, {
              runId: params.run,
              callerTerminalHandle: params.callerTerminalHandle,
              requireCurrentConsumer: params.run === undefined,
              legacyCoordinatorRunId,
              callerEvidence: orchestrationCompatibilityEvidence
            })
      // Why: listTasksWithDispatch adds assignee_handle + dispatch_id (NULL for non-dispatched), so legacy-shape consumers are unaffected.
      const joined = db.listTasksWithDispatch({
        status: params.status as TaskStatus,
        ready: params.ready,
        runId: run.id
      })
      const tasks = joined.map((row) => {
        const { assignee_handle, dispatch_id, ...base } = row
        if (base.status === 'dispatched') {
          return { ...base, assignee_handle, dispatch_id }
        }
        return base
      })
      return {
        runId: run.id,
        legacyReadOnly: run.legacy === 1,
        tasks: params.brief ? abbreviateOrchestrationTasks(tasks) : tasks,
        count: tasks.length
      }
    }
  }),

  defineMethod({
    name: 'orchestration.taskUpdate',
    params: TaskUpdateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.callerTerminalHandle,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const existing = db.getTask(params.id)
      if (!existing || existing.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.id} was not found in Run ${run.id}.`
        )
      }
      const task = db.updateTaskStatus(params.id, params.status, params.result)
      if (!task) {
        throw new Error(`Task not found: ${params.id}`)
      }
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatch',
    params: DispatchParams,
    handler: async (
      params,
      {
        orchestrationCompatibilityEvidence,
        runtime,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const task = db.getTask(params.task)
      if (!task) {
        throw new Error(`Task not found: ${params.task}`)
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      if (task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${task.id} was not found in Run ${run.id}.`
        )
      }

      // Why: dry-run previews the preamble without mutating state, so it skips the ready-status check and uses a placeholder dispatchId.
      if (params.dryRun) {
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: 'ctx_dryrun',
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle: params.to ?? 'worker',
          devMode: params.devMode,
          ...(params.to
            ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(params.to) }
            : {})
        })
        return { dispatch: null, injected: false, dryRun: true, preamble }
      }

      if (!params.to) {
        throw new Error('Missing --to')
      }
      const to = params.to

      if (task.status !== 'ready') {
        throw new Error(`Task ${params.task} is ${task.status}; only ready tasks can be dispatched`)
      }

      // Why: injecting the preamble into a bare shell dumps it as shell commands (gibberish), so require a detected agent first.
      if (params.inject) {
        const hasAgent = await runtime.isTerminalRunningAgent(to)
        if (!hasAgent) {
          throw new Error(
            `Cannot dispatch --inject to terminal ${to}: no recognized agent detected. ` +
              'Start an agent CLI (e.g. claude, codex, gemini, droid, cursor) in the terminal first, ' +
              'or dispatch without --inject and send the prompt manually.'
          )
        }
      }

      const dispatchAuthority = runtime.getOrchestrationDispatchAuthority(to)
      const assigneePaneKey =
        dispatchAuthority?.paneKey ?? runtime.getTerminalPaneKey(to) ?? undefined
      const processIncarnation =
        dispatchAuthority?.processIncarnation ??
        runtime.getTerminalProcessIncarnation(to) ??
        undefined
      if (params.inject && (!assigneePaneKey || !processIncarnation)) {
        throw new OrchestrationError(
          'stable_pane_required',
          `Terminal ${to} has no stable pane/process incarnation for lifecycle authority.`
        )
      }

      revalidateLegacyCoordinator?.()
      const ctx = db.createDispatchContext(
        params.task,
        to,
        assigneePaneKey,
        dispatchAuthority?.launchTokenHash ?? undefined
      )
      const dispatchCapability = params.inject
        ? db.mintDispatchCapability({
            dispatchId: ctx.id,
            paneKey: assigneePaneKey as string,
            processIncarnation: processIncarnation as string
          })
        : undefined

      // Why: built after ctx so dispatchId is the real ctx.id, letting heartbeats attribute liveness to a specific dispatch context, not just a task.
      const preamble = buildDispatchPreamble({
        taskId: task.id,
        dispatchId: ctx.id,
        taskSpec: task.spec,
        coordinatorHandle: params.from ?? 'coordinator',
        workerHandle: to,
        dispatchCapability,
        devMode: params.devMode,
        cliCommand: runtime.getTerminalOrchestrationCliCommand(to)
      })

      let injected = false
      if (params.inject) {
        try {
          await runtime.sendTerminalAgentPrompt(to, preamble)
          injected = true
        } catch (err) {
          db.failDispatch(ctx.id, err instanceof Error ? err.message : String(err))
          throw err
        }
      }

      // Why: returnPreamble is opt-in because the preamble is several hundred bytes most callers don't need in the response.
      if (params.returnPreamble) {
        return { dispatch: ctx, injected, preamble }
      }
      return { dispatch: ctx, injected }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatchShow',
    params: DispatchShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (!params.task) {
        throw new Error('Missing --task')
      }
      const ctx = db.getDispatchContext(params.task)

      // Why: the preamble is derived from the current task spec, so it can be regenerated deterministically even after dispatch completes.
      if (params.preamble) {
        const task = db.getTask(params.task)
        if (!task) {
          throw new Error(`Task not found: ${params.task}`)
        }
        const workerHandle = ctx?.assignee_handle ?? 'worker'
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          // Why: use the real ctx.id when present so the preview matches what was injected; placeholder when no dispatch has occurred yet.
          dispatchId: ctx?.id ?? 'ctx_preview',
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle,
          devMode: params.devMode,
          ...(ctx ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(workerHandle) } : {})
        })
        return { dispatch: ctx ?? null, preamble }
      }

      return { dispatch: ctx ?? null }
    }
  }),

  defineMethod({
    name: 'orchestration.ask',
    params: AskParams,
    handler: async (
      params,
      { runtime, signal, orchestrationCapability, recordMutationReceipt }
    ) => {
      // Why: group addresses have no unambiguous first-answer authority.
      if (params.to && isGroupAddress(params.to)) {
        throw new Error(
          'ask does not support group addresses; use send for non-blocking fan-out questions'
        )
      }

      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      // Why: echoed on every return so a clamped caller reports the budget actually waited, not the one it asked for.
      const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
      const paneKey = runtime.getTerminalPaneKey(from) ?? undefined
      const remoteAttachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
      if (remoteAttachment) {
        rejectFederatedExplicitTarget(params)
        return askRemoteRunHome({
          params: { ...params, timeoutMs },
          runtime,
          signal,
          orchestrationCapability,
          recordMutationReceipt,
          from,
          paneKey: paneKey as string,
          dispatchId: remoteAttachment.dispatch_id,
          taskId: remoteAttachment.task_id
        })
      }
      const activeDispatch = db.getActiveDispatchForIdentity(from, paneKey)
      if (!activeDispatch) {
        throw new OrchestrationError(
          'dispatch_inactive',
          'ask requires an active supervised Dispatch.'
        )
      }
      if (activeDispatch.capability_hash) {
        const authority = db.verifyDispatchCapability({
          dispatchId: activeDispatch.id,
          capability: orchestrationCapability,
          paneKey,
          processIncarnation: runtime.getTerminalProcessIncarnation(from) ?? undefined
        })
        if (!authority.valid) {
          throw new OrchestrationError('dispatch_capability_invalid', authority.reason)
        }
      }
      const options =
        params.options
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []
      let question = params.resume ? db.getQuestion(params.resume) : undefined
      if (params.resume) {
        if (!question || question.dispatch_id !== activeDispatch.id) {
          throw new OrchestrationError(
            'question_not_found',
            `Question ${params.resume} does not belong to this active Dispatch.`
          )
        }
      } else {
        const run = db.getRun(activeDispatch.run_id)
        if (!run || run.legacy === 1) {
          throw new OrchestrationError(
            'run_not_found',
            `Run ${activeDispatch.run_id} was not found.`
          )
        }
        if (params.run && params.run !== run.id) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `Dispatch ${activeDispatch.id} belongs to Run ${run.id}, not ${params.run}.`
          )
        }
        if (params.to && params.to !== `run:${run.id}` && params.to !== run.coordinator_handle) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `ask from Dispatch ${activeDispatch.id} must target its owning Run ${run.id}.`
          )
        }
        const created = db.createQuestion({
          runId: run.id,
          dispatchId: activeDispatch.id,
          askerHandle: from,
          question: params.question as string,
          options
        })
        question = created.question
        runtime.notifyMessageArrived(`run:${run.id}`, created.message.type)
      }

      const questionId = question.message_id
      recordMutationReceipt?.({
        accepted: true,
        answer: null,
        messageId: questionId,
        threadId: questionId,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      })
      const deadline = Date.now() + timeoutMs
      while (true) {
        const current = db.getQuestion(questionId)
        if (!current || current.status === 'closed') {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Question ${questionId} closed because its Dispatch is inactive.`
          )
        }
        if (current.status === 'answered') {
          return {
            answer: current.answer_body,
            messageId: questionId,
            answerMessageId: current.answer_message_id,
            threadId: questionId,
            timedOut: false,
            cancelled: false,
            connectionLost: false,
            timeoutMs
          }
        }
        if (signal?.aborted) {
          return {
            answer: null,
            messageId: questionId,
            threadId: questionId,
            timedOut: false,
            cancelled: true,
            connectionLost: true,
            timeoutMs
          }
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          return {
            answer: null,
            messageId: questionId,
            threadId: questionId,
            timedOut: true,
            cancelled: false,
            connectionLost: false,
            timeoutMs
          }
        }
        await runtime.waitForMessage(`dispatch:${activeDispatch.id}`, {
          timeoutMs: remainingMs,
          signal
        })
      }
    }
  }),

  ...ORCHESTRATION_GATE_METHODS,

  defineMethod({
    name: 'orchestration.reset',
    params: ResetParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (params.all) {
        db.resetAll()
        return { reset: 'all' }
      }
      if (params.tasks) {
        db.resetTasks()
        return { reset: 'tasks' }
      }
      if (params.messages) {
        db.resetMessages()
        return { reset: 'messages' }
      }
      throw new Error('Invalid reset scope')
    }
  })
]

async function askRemoteRunHome(args: {
  params: z.infer<typeof AskParams>
  runtime: OrcaRuntimeService
  signal?: AbortSignal
  orchestrationCapability?: string
  recordMutationReceipt?: (receipt: unknown) => void
  from: string
  paneKey: string
  dispatchId: string
  taskId: string
}): Promise<unknown> {
  const db = args.runtime.getOrchestrationDb()
  const timeoutMs = clampOrchestrationAskTimeoutMs(args.params.timeoutMs)
  if (
    !db.verifyRemoteAttachmentAuthority({
      dispatchId: args.dispatchId,
      capability: args.orchestrationCapability,
      paneKey: args.paneKey,
      processIncarnation: args.runtime.getTerminalProcessIncarnation(args.from)
    })
  ) {
    throw new OrchestrationError(
      'dispatch_capability_invalid',
      'The remote Dispatch capability or exact worker process is invalid.'
    )
  }
  const options =
    args.params.options
      ?.split(',')
      .map((option) => option.trim())
      .filter(Boolean) ?? []
  let questionId = args.params.resume
  if (questionId) {
    const existing = db.getRemoteQuestion(questionId)
    if (!existing || existing.dispatch_id !== args.dispatchId) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${questionId} does not belong to this remote Dispatch.`
      )
    }
  } else {
    const relay = db.enqueueFederationRelay({
      dispatchId: args.dispatchId,
      direction: 'to_home',
      kind: 'question',
      payload: JSON.stringify({
        from: args.from,
        subject: 'Question',
        body: args.params.question as string,
        type: 'question',
        priority: 'normal',
        threadId: null,
        payload: JSON.stringify({
          taskId: args.taskId,
          dispatchId: args.dispatchId,
          question: args.params.question,
          options
        })
      }),
      remoteQuestion: true
    })
    questionId = relay.message_id
  }
  args.recordMutationReceipt?.({
    accepted: true,
    answer: null,
    messageId: questionId,
    threadId: questionId,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    timeoutMs
  })
  const deadline = Date.now() + timeoutMs
  while (true) {
    const question = db.getRemoteQuestion(questionId)
    if (!question || question.status === 'closed') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Question ${questionId} closed because its remote Dispatch is inactive.`
      )
    }
    if (question.status === 'answered') {
      return {
        answer: question.answer_body,
        messageId: questionId,
        answerMessageId: question.answer_message_id,
        threadId: questionId,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      }
    }
    if (args.signal?.aborted) {
      return {
        answer: null,
        messageId: questionId,
        threadId: questionId,
        timedOut: false,
        cancelled: true,
        connectionLost: true,
        timeoutMs
      }
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return {
        answer: null,
        messageId: questionId,
        threadId: questionId,
        timedOut: true,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      }
    }
    await args.runtime.waitForMessage(`dispatch:${args.dispatchId}`, {
      timeoutMs: remainingMs,
      signal: args.signal
    })
  }
}
