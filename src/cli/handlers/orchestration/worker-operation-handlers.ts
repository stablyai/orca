import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { requireWorkerDoneSettlement } from '../orchestration-worker-settlement'
import { callOrchestrationMutation } from './mutation-request'
import { isDevCliInvocation } from './runtime-compatibility'
import {
  resolveOrchestrationTerminalHandle,
  throwNoActiveSenderTerminal
} from './terminal-identity'
import { lifecycleRejectionRecovery } from '../../orchestration-lifecycle-rejection-recovery'

/** B5 — the two typed worker operations. Everything a worker used to assemble
 *  by hand (message type, recipient, payload JSON, lifecycle flag ordering) is
 *  fixed here; the runtime-generated preamble supplies the bound ids and the
 *  model supplies only free text.
 *
 *  These are thin adapters over the existing `orchestration.send` contract, so
 *  the wire protocol, Delivery semantics and settlement path are unchanged —
 *  there is no second orchestrator. */

type LifecycleSendResult =
  | { action: 'completed' | 'failed' }
  | { action: 'settled'; outcome: 'succeeded' | 'failed'; duplicate?: boolean }
  | { action: 'rejected'; code: string; reason: string }

type WorkerOperationResult = {
  message?: { id: string }
  relay?: { messageId: string; dispatchId: string }
  lifecycle?: LifecycleSendResult
}

async function resolveWorkerIdentity(args: {
  flags: Map<string, string | boolean>
  cwd: string
  client: Parameters<CommandHandler>[0]['client']
}): Promise<{ from: string; taskId: string; dispatchId: string }> {
  const { flags, cwd, client } = args
  if (!getOptionalStringFlag(flags, 'from') && !process.env.ORCA_TERMINAL_HANDLE) {
    // Why: focus is not lifecycle authority — an identity-less subprocess must
    // fail closed rather than guess which worker is reporting.
    throwNoActiveSenderTerminal()
  }
  return {
    from: await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from'),
    taskId: getRequiredStringFlag(flags, 'task'),
    dispatchId: getRequiredStringFlag(flags, 'dispatch')
  }
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

export const ORCHESTRATION_WORKER_OPERATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration report': async ({ flags, client, cwd, json }) => {
    const identity = await resolveWorkerIdentity({ flags, cwd, client })
    const outcome = getRequiredStringFlag(flags, 'outcome')
    if (outcome !== 'succeeded' && outcome !== 'failed') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Invalid --outcome. Expected succeeded or failed.'
      )
    }
    const body = getRequiredStringFlag(flags, 'body')
    const runId = getOptionalStringFlag(flags, 'run')
    const outcomeId = getOptionalStringFlag(flags, 'outcome-id')
    const payload: Record<string, unknown> = {
      taskId: identity.taskId,
      dispatchId: identity.dispatchId,
      outcome,
      ...(outcomeId ? { outcomeId } : {})
    }
    const filesModified = splitCsv(getOptionalStringFlag(flags, 'files-modified'))
    if (filesModified) {
      payload.filesModified = filesModified
    }
    const reportPath = getOptionalStringFlag(flags, 'report-path')
    if (reportPath) {
      payload.reportPath = reportPath
    }
    // Why on the report: a reviewer's verdict and its required changes are one
    // atomic fact, so FIX_FIRST cannot race a separate message.
    const corrections = splitCsv(getOptionalStringFlag(flags, 'corrections'))
    if (corrections) {
      payload.corrections = corrections
    }
    // Deliberately no SHA, cleanliness or gate result in the worker payload.
    // The runtime observes Git and reads its own gate-execution ledger on the
    // worker_done transaction. Letting this adapter synthesize those fields
    // would turn a local CLI process back into the evidence authority.
    const serializedPayload = JSON.stringify(payload)
    const result = await callOrchestrationMutation<WorkerOperationResult>(
      client,
      flags,
      'orchestration.send',
      {
        from: identity.from,
        run: runId,
        subject: getOptionalStringFlag(flags, 'subject') ?? `Task ${identity.taskId} ${outcome}`,
        body,
        type: 'worker_done',
        payload: serializedPayload,
        senderPaneKey: process.env.ORCA_PANE_KEY || undefined,
        waitForLifecycleSettlement: true,
        devMode: isDevCliInvocation()
      },
      dispatchCapabilityOption(flags)
    )
    await requireWorkerDoneSettlement(client, 'worker_done', serializedPayload, result.result)
    if (result.result.lifecycle?.action === 'rejected') {
      throw new RuntimeClientError(
        result.result.lifecycle.code,
        result.result.lifecycle.reason,
        lifecycleRejectionRecovery(result.result.lifecycle.code)
      )
    }
    printResult(result, json, (value) =>
      value.message ? `Reported ${value.message.id}` : `Queued ${value.relay?.messageId}`
    )
  },

  'orchestration escalate': async ({ flags, client, cwd, json }) => {
    const identity = await resolveWorkerIdentity({ flags, cwd, client })
    const result = await callOrchestrationMutation<WorkerOperationResult>(
      client,
      flags,
      'orchestration.send',
      {
        from: identity.from,
        run: getOptionalStringFlag(flags, 'run'),
        subject: getRequiredStringFlag(flags, 'subject'),
        body: getOptionalStringFlag(flags, 'body'),
        type: 'escalation',
        priority: getOptionalStringFlag(flags, 'priority'),
        payload: JSON.stringify({
          taskId: identity.taskId,
          dispatchId: identity.dispatchId
        }),
        senderPaneKey: process.env.ORCA_PANE_KEY || undefined,
        devMode: isDevCliInvocation()
      },
      dispatchCapabilityOption(flags)
    )
    printResult(result, json, (value) =>
      value.message ? `Escalated ${value.message.id}` : `Queued ${value.relay?.messageId}`
    )
  }
}

function dispatchCapabilityOption(
  flags: Map<string, string | boolean>
): { orchestrationCapability: string } | undefined {
  const capability = getOptionalStringFlag(flags, 'dispatch-capability')
  return capability ? { orchestrationCapability: capability } : undefined
}
