import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { requireWorkerDoneSettlement } from '../orchestration-worker-settlement'
import { getOptionalStructuredMessagePayload } from './message-payload'
import { callOrchestrationMutation } from './mutation-request'
import { isDevCliInvocation } from './runtime-compatibility'
import {
  resolveOrchestrationTerminalHandle,
  throwNoActiveSenderTerminal
} from './terminal-identity'

type LifecycleSendResult =
  | {
      action: 'completed' | 'failed'
      authority?: 'run_home' | 'worker_server_legacy'
    }
  | { action: 'settled'; outcome: 'succeeded' | 'failed'; duplicate?: boolean }
  | { action: 'rejected'; code: string; reason: string }

type SendRecipientWarning = {
  code: string
  recipient: string
  message: string
}

type OrchestrationSendResult =
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
      !process.env.ORCA_TERMINAL_HANDLE
    ) {
      // Why: focus isn't lifecycle authority — an identity-less subprocess must fail closed rather than guess the worker.
      throwNoActiveSenderTerminal()
    }

    // Why: lifecycle senders preserve ORCA_TERMINAL_HANDLE across restarts for older runtimes.
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
      // Why: pane key is the remint-stable sender identity the runtime verifies lifecycle ownership against; older runtimes strip it.
      senderPaneKey: process.env.ORCA_PANE_KEY || undefined,
      waitForLifecycleSettlement: type === 'worker_done' ? true : undefined,
      devMode: isDevCliInvocation()
    }
    const dispatchCapability = getOptionalStringFlag(flags, 'dispatch-capability')
    const result = await callOrchestrationMutation<OrchestrationSendResult>(
      client,
      flags,
      'orchestration.send',
      sendParams,
      dispatchCapability ? { orchestrationCapability: dispatchCapability } : undefined
    )
    await requireWorkerDoneSettlement(client, type, sendParams.payload, result.result)
    if ('lifecycle' in result.result && result.result.lifecycle?.action === 'rejected') {
      throw new RuntimeClientError(result.result.lifecycle.code, result.result.lifecycle.reason)
    }
    printResult(result, json, (value) => {
      const warnings = 'warnings' in value ? (value.warnings ?? []) : []
      const withWarnings = (line: string): string =>
        warnings.length > 0
          ? [line, ...warnings.map((warning) => `Warning: ${warning.message}`)].join('\n')
          : line
      if ('message' in value) {
        return withWarnings(`Sent ${value.message.id}`)
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
