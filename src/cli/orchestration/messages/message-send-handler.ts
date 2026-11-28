import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import { withReceiptNext } from '../receipt-next-text'
import { formatWorkerStart } from '../workers/worker-output'
import {
  WORKER_FOLLOW_UP_VIEW,
  type WorkerFollowUpReceipt
} from '../workers/worker-start-agent-view'
import { withResolvedNextCommands } from '../recovery/orchestration-mutation-recovery'
import {
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../../arguments/flags'
import { RuntimeClientError } from '../../runtime/connection/types'
import { readTextOrFileFlag } from '../../arguments/command-body-input'
import { readInjectedAgentSessionId } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { WORKER_DONE_BLANK_BODY_ERROR } from '../../../shared/rpc-contract/orchestration/orchestration-params'
import { requireWorkerDoneSettlement } from '../workers/orchestration-worker-settlement'
import { getOptionalStructuredMessagePayload } from './message-payload'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { isDevCliInvocation } from '../recovery/runtime-compatibility'
import { refuseAgentServerRoute, requirePeerMailCarrier } from '../identity/agent-server-route'
import {
  resolveOrchestrationTerminalHandle,
  throwNoActiveSenderTerminal
} from '../identity/terminal-identity'
import { resolveCallerFilePath } from '../../arguments/caller-file-path'

const WORKER_DONE_RETRY_MS = 120_000

type LifecycleSendResult =
  | {
      action: 'completed' | 'failed'
      authority?: 'run_home' | 'worker_server_legacy'
      autoReleaseAt?: string
    }
  | { action: 'settled'; outcome: 'succeeded' | 'failed'; duplicate?: boolean }
  | { action: 'rejected'; code: string; reason: string }

type SendRecipientWarning = {
  code: string
  recipient: string
  message: string
}

type OrchestrationSendResult = { next?: string } & (
  | {
      message: { id: string; run_id?: string }
      lifecycle?: LifecycleSendResult
      warnings?: SendRecipientWarning[]
    }
  | {
      messages: { id: string }[]
      recipients: number
      warnings?: SendRecipientWarning[]
    }
  | (WorkerFollowUpReceipt & { warnings?: SendRecipientWarning[] })
  | {
      relay: {
        messageId: string
        sequence: number
        dispatchId: string
        destination?: 'run_home' | 'worker'
        accepted: true
      }
      lifecycle?: LifecycleSendResult
      warnings?: SendRecipientWarning[]
    }
)

function getLifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

function rejectLifecycleGroupRecipient(type: string | undefined, to: string): void {
  if ((type === 'worker_done' || type === 'heartbeat') && to.startsWith('@')) {
    throw new RuntimeClientError('invalid_argument', getLifecycleGroupRecipientError(type))
  }
}

export const ORCHESTRATION_SEND_HANDLER: Record<string, CommandHandler> = {
  'orchestration send': async (ctx) => {
    const { flags, client, cwd, json } = ctx
    const type = getOptionalStringFlag(flags, 'type')
    const body = await readTextOrFileFlag(flags, cwd, 'body', false)
    // Older runtimes read '' as no body and complete the Task without its report.
    if (type === 'worker_done' && body?.trim() === '') {
      throw new RuntimeClientError('invalid_argument', WORKER_DONE_BLANK_BODY_ERROR)
    }
    await refuseAgentServerRoute('send', ctx)
    await requirePeerMailCarrier(ctx)
    const to = getOptionalStringFlag(flags, 'to')
    if (to) {
      rejectLifecycleGroupRecipient(type, to)
    }
    const outcome = getOptionalStringFlag(flags, 'outcome')
    if (type !== 'worker_done' && outcome !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--outcome is only valid with --type worker_done.'
      )
    }
    if (
      (type === 'worker_done' || type === 'heartbeat') &&
      !getOptionalStringFlag(flags, 'from') &&
      !process.env.ORCA_TERMINAL_HANDLE &&
      !readInjectedAgentSessionId()
    ) {
      // Focus cannot establish lifecycle ownership; never guess a worker for an identity-less subprocess.
      throwNoActiveSenderTerminal()
    }

    // Preserve the env handle across remints for older runtimes' lifecycle ownership checks.
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const sendParams = {
      from,
      to,
      chat: getOptionalStringFlag(flags, 'chat'),
      item: getOptionalStringFlag(flags, 'item'),
      ...attachedFiles(flags, cwd),
      run: getOptionalStringFlag(flags, 'run'),
      on: getOptionalStringFlag(flags, 'on'),
      onClient: getOptionalStringFlag(flags, 'on-client'),
      subject: getRequiredStringFlag(flags, 'subject'),
      body,
      type,
      priority: getOptionalStringFlag(flags, 'priority'),
      threadId: getOptionalStringFlag(flags, 'thread-id'),
      payload: getOptionalStructuredMessagePayload(flags),
      // Pane keys survive remints; sessions instead authenticate by injected id, never inherited pane keys.
      senderPaneKey:
        from === undefined || readInjectedAgentSessionId()
          ? undefined
          : process.env.ORCA_PANE_KEY || undefined,
      waitForLifecycleSettlement: type === 'worker_done' ? true : undefined,
      devMode: isDevCliInvocation()
    }
    const dispatchCapability = getOptionalStringFlag(flags, 'dispatch-capability')
    const result = await callOrchestrationMutation<OrchestrationSendResult>(
      client,
      flags,
      'orchestration.send',
      sendParams,
      dispatchCapability ? { orchestrationCapability: dispatchCapability } : undefined,
      // Workers report once before ending their turn; retry outages and timeouts so worker_done is not lost.
      // The 120 s budget bounds retry starts: a backoff must fit inside it, and a retry starts only if
      // it is still open after the backoff. Each attempt can then wait out the send's own inactivity
      // timeout (110 s, refreshed by keepalives) plus connection setup, so the whole send can run past
      // 120 s. After a timeout, a possibly delivered report gets exactly one replay, never a fresh send.
      type === 'worker_done' ? WORKER_DONE_RETRY_MS : 0
    )
    await requireWorkerDoneSettlement(client, type, sendParams.payload, result.result)
    if ('lifecycle' in result.result && result.result.lifecycle?.action === 'rejected') {
      throw new RuntimeClientError(result.result.lifecycle.code, result.result.lifecycle.reason)
    }
    if (!flags.has('full')) {
      if ('delivery' in result.result) {
        const followUp = withResolvedNextCommands(result.result)
        printOrchestrationResult({ ...result, result: followUp }, json, WORKER_FOLLOW_UP_VIEW)
      } else {
        printOrchestrationResult({ ...result, result: result.result }, json, { fields: sendFields })
      }
      return
    }
    if ('delivery' in result.result && result.result.state !== 'ready') {
      process.exitCode = 1
    }
    const rendered =
      'delivery' in result.result
        ? { ...result, result: withResolvedNextCommands(result.result) }
        : result
    printResult(rendered, json, (value) => {
      const warnings = 'warnings' in value ? (value.warnings ?? []) : []
      const withWarnings = (line: string): string =>
        withReceiptNext(
          [line, ...warnings.map((warning) => `Warning: ${warning.message}`)].join('\n'),
          value
        )
      if ('message' in value) {
        const lifecycle = 'lifecycle' in value ? value.lifecycle : undefined
        const autoRelease =
          lifecycle && 'autoReleaseAt' in lifecycle && lifecycle.autoReleaseAt
            ? ` (terminal auto-release at ${lifecycle.autoReleaseAt})`
            : ''
        return withWarnings(`Sent ${value.message.id}${autoRelease}`)
      }
      if ('delivery' in value) {
        return withWarnings(
          `Follow-up of ${value.followUpOf} (${value.delivery})\n${formatWorkerStart(
            // The mode line describes a new launch; only a fresh start is one.
            value.delivery === 'started_fresh' ? value : { ...value, mode: undefined }
          )}`
        )
      }
      if ('relay' in value) {
        if (value.relay.destination === 'worker') {
          return withWarnings(
            `Queued ${value.relay.messageId} for worker Dispatch ${value.relay.dispatchId}`
          )
        }
        return withWarnings(
          `Queued ${value.relay.messageId} for Run home (Dispatch ${value.relay.dispatchId})`
        )
      }
      return withWarnings(
        `Sent ${value.messages.length} messages to ${value.recipients} recipients`
      )
    })
  }
}

type SendFields = {
  messageId?: string
  messageIds?: string[]
  recipients?: number
  dispatchId?: string
  queuedFor?: 'run_home' | 'worker'
  lifecycle?: string
  autoReleaseAt?: string
  warnings?: string[]
  next?: string
}

// The message row echoes what the caller just sent; only its id is new.
function sendFields(value: Exclude<OrchestrationSendResult, { delivery: string }>): SendFields {
  const lifecycle = 'lifecycle' in value ? value.lifecycle : undefined
  const common = {
    lifecycle: lifecycle?.action,
    autoReleaseAt: lifecycle && 'autoReleaseAt' in lifecycle ? lifecycle.autoReleaseAt : undefined,
    warnings: value.warnings?.length ? value.warnings.map((warning) => warning.message) : undefined,
    next: value.next
  }
  if ('message' in value) {
    return { messageId: value.message.id, ...common }
  }
  if ('relay' in value) {
    return {
      messageId: value.relay.messageId,
      dispatchId: value.relay.dispatchId,
      queuedFor: value.relay.destination ?? 'run_home',
      ...common
    }
  }
  return {
    messageIds: value.messages.map((message) => message.id),
    recipients: value.recipients,
    ...common
  }
}

/** `--file`, each by its full path from the caller's folder. */
function attachedFiles(flags: Map<string, string | boolean>, cwd: string): { files?: string[] } {
  const files = getRepeatedStringFlag(flags, 'file').map((path) => resolveCallerFilePath(path, cwd))
  return files.length > 0 ? { files } : {}
}
