import type { CommandHandler } from '../../dispatch'
import { printOrchestrationResult, resolveOrcaCommandsInText } from './agent-view'
import { withReceiptNext } from './receipt-next-text'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { readInjectedAgentSessionId } from '../../../shared/agent-session-caller-env'
import { requireWorkerDoneSettlement } from '../orchestration-worker-settlement'
import { getOptionalStructuredMessagePayload } from './message-payload'
import { callOrchestrationMutation } from './mutation-request'
import { isDevCliInvocation } from './runtime-compatibility'
import {
  resolveOrchestrationTerminalHandle,
  throwNoActiveSenderTerminal
} from './terminal-identity'

const WORKER_DONE_UNAVAILABLE_RETRY_MS = 120_000

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
  'orchestration send': async ({ flags, client, cwd, json }) => {
    const to = getOptionalStringFlag(flags, 'to')
    const type = getOptionalStringFlag(flags, 'type')
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
      run: getOptionalStringFlag(flags, 'run'),
      subject: getRequiredStringFlag(flags, 'subject'),
      body: getOptionalStringFlag(flags, 'body'),
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
      // Workers report once before ending their turn; retry brief outages so worker_done is not lost.
      type === 'worker_done' ? WORKER_DONE_UNAVAILABLE_RETRY_MS : 0
    )
    await requireWorkerDoneSettlement(client, type, sendParams.payload, result.result)
    if ('lifecycle' in result.result && result.result.lifecycle?.action === 'rejected') {
      throw new RuntimeClientError(result.result.lifecycle.code, result.result.lifecycle.reason)
    }
    printOrchestrationResult(
      result,
      { flags, json },
      {
        fields: sendFields,
        fullText: (value) => formatSendFields({ ...sendFields(value), next: value.next })
      }
    )
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
function sendFields(value: OrchestrationSendResult): SendFields {
  const lifecycle = 'lifecycle' in value ? value.lifecycle : undefined
  const common = {
    lifecycle: lifecycle?.action,
    autoReleaseAt: lifecycle && 'autoReleaseAt' in lifecycle ? lifecycle.autoReleaseAt : undefined,
    warnings: value.warnings?.length ? value.warnings.map((warning) => warning.message) : undefined,
    next: value.next && resolveOrcaCommandsInText(value.next)
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

function formatSendFields(fields: SendFields): string {
  const head =
    fields.messageIds !== undefined
      ? `Sent ${fields.messageIds.length} messages to ${fields.recipients} recipients`
      : fields.dispatchId === undefined
        ? `Sent ${fields.messageId}${fields.autoReleaseAt ? ` (terminal auto-release at ${fields.autoReleaseAt})` : ''}`
        : fields.queuedFor === 'worker'
          ? `Queued ${fields.messageId} for worker Dispatch ${fields.dispatchId}`
          : `Queued ${fields.messageId} for Run home (Dispatch ${fields.dispatchId})`
  return withReceiptNext(
    [head, ...(fields.warnings ?? []).map((warning) => `Warning: ${warning}`)].join('\n'),
    fields
  )
}
