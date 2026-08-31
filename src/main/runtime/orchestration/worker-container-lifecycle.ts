import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrchestrationDb } from './db'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import {
  isWorkerLifecycleReceiptUnreadable,
  readBoundedWorkerLifecycleReceipt
} from './worker-container-lifecycle-receipt'

const LIFECYCLE_SCHEMA_VERSION = 'worker_lifecycle_receipt/1'
const MAX_LIFECYCLE_RECEIPT_BYTES = 64 * 1024 * 6 + 512 * 6 + 4 * 1024
const LIFECYCLE_POLL_MS = 250
const LIFECYCLE_MONITOR_MS = 24 * 60 * 60 * 1_000

export type WorkerContainerLifecycleBoundary = {
  directory: string
  binding: `sha256:${string}`
}

type WorkerContainerLifecycleReceipt = {
  schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION
  dispatchId: string
  lifecycleBinding: string
  type: 'worker_done' | 'escalation'
  subject: string
  body: string
  outcome?: 'succeeded' | 'failed'
}

type WorkerContainerLifecycleAdmission = 'absent' | 'admitted' | 'settled'

export function createWorkerContainerLifecycleBoundary(args: {
  dispatchId: string
  capabilityRef: string
}): WorkerContainerLifecycleBoundary {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(args.dispatchId)) {
    throw new Error('worker_authority_isolation_failed')
  }
  const requestedRoot = join(tmpdir(), 'orca-worker-lifecycle-v1')
  mkdirSync(requestedRoot, { recursive: true, mode: 0o700 })
  const root = realpathSync(requestedRoot)
  const directory = join(root, args.dispatchId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) {
    throw new Error('worker_authority_isolation_failed')
  }
  const binding = `sha256:${createHash('sha256')
    .update(`${args.capabilityRef}\n${args.dispatchId}`)
    .digest('hex')}` as const
  return { directory, binding }
}

function parseReceipt(path: string): WorkerContainerLifecycleReceipt {
  const value: unknown = JSON.parse(
    readBoundedWorkerLifecycleReceipt(path, MAX_LIFECYCLE_RECEIPT_BYTES)
  )
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('worker_lifecycle_receipt_invalid')
  }
  const receipt = value as Partial<WorkerContainerLifecycleReceipt>
  if (
    receipt.schemaVersion !== LIFECYCLE_SCHEMA_VERSION ||
    typeof receipt.dispatchId !== 'string' ||
    typeof receipt.lifecycleBinding !== 'string' ||
    (receipt.type !== 'worker_done' && receipt.type !== 'escalation') ||
    typeof receipt.subject !== 'string' ||
    receipt.subject.length === 0 ||
    Buffer.byteLength(receipt.subject) > 512 ||
    typeof receipt.body !== 'string' ||
    Buffer.byteLength(receipt.body) > 64 * 1024 ||
    (receipt.type === 'worker_done' &&
      receipt.outcome !== 'succeeded' &&
      receipt.outcome !== 'failed') ||
    (receipt.type === 'escalation' && receipt.outcome !== undefined)
  ) {
    throw new Error('worker_lifecycle_receipt_invalid')
  }
  return receipt as WorkerContainerLifecycleReceipt
}

export function admitWorkerContainerLifecycleReceipt(args: {
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  terminalHandle: string
  lifecycle: WorkerContainerLifecycleBoundary
  notify: (handle: string, messageType?: string) => void
}): WorkerContainerLifecycleAdmission {
  const resultPath = join(args.lifecycle.directory, 'result.json')
  if (!existsSync(resultPath)) {
    return 'absent'
  }
  const receipt = parseReceipt(resultPath)
  if (
    receipt.dispatchId !== args.dispatchId ||
    receipt.lifecycleBinding !== args.lifecycle.binding
  ) {
    throw new Error('worker_lifecycle_receipt_mismatch')
  }
  const dispatch = args.db.getDispatchContextById(args.dispatchId)
  if (
    !dispatch ||
    dispatch.task_id !== args.taskId ||
    dispatch.assignee_handle !== args.terminalHandle
  ) {
    throw new Error('worker_lifecycle_receipt_stale')
  }
  const messageId = `msg_${createHash('sha256')
    .update(
      JSON.stringify({
        dispatchId: args.dispatchId,
        lifecycleBinding: args.lifecycle.binding,
        type: receipt.type,
        outcome: receipt.outcome ?? null,
        subject: receipt.subject,
        body: receipt.body
      })
    )
    .digest('hex')
    .slice(0, 24)}`
  let message = args.db.getMessageById(messageId)
  if (!message) {
    message = args.db.insertMessage({
      id: messageId,
      runId: args.runId,
      from: args.terminalHandle,
      to: `run:${args.runId}`,
      senderPaneKey: dispatch.assignee_pane_key ?? undefined,
      type: receipt.type,
      priority: receipt.type === 'escalation' ? 'high' : 'normal',
      subject: receipt.subject,
      body: receipt.body,
      payload: JSON.stringify({
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
        lifecycleAdapter: 'container-file'
      })
    })
  }
  if (message.type === 'worker_done') {
    reconcileLifecycleMessage(args.db, message)
  }
  args.notify(message.to_handle, message.type)
  const admittedPath = join(args.lifecycle.directory, `${messageId}.admitted.json`)
  if (existsSync(admittedPath)) {
    unlinkSync(resultPath)
  } else {
    renameSync(resultPath, admittedPath)
  }
  return receipt.type === 'worker_done' ? 'settled' : 'admitted'
}

function quarantineRejectedLifecycleReceipt(
  args: Parameters<typeof admitWorkerContainerLifecycleReceipt>[0],
  error: unknown
): void {
  const resultPath = join(args.lifecycle.directory, 'result.json')
  if (!existsSync(resultPath)) {
    return
  }
  const rejectedName = `rejected-${randomUUID()}.json`
  const rejectedPath = join(args.lifecycle.directory, rejectedName)
  renameSync(resultPath, rejectedPath)
  const reason = error instanceof Error ? error.message : String(error)
  try {
    const message = args.db.insertMessage({
      id: `msg_${createHash('sha256')
        .update(`${args.dispatchId}\n${rejectedName}`)
        .digest('hex')
        .slice(0, 24)}`,
      runId: args.runId,
      from: args.terminalHandle,
      to: `run:${args.runId}`,
      type: 'escalation',
      priority: 'high',
      subject: 'Container lifecycle receipt rejected',
      body: `Orca rejected a container lifecycle receipt (${reason}). The worker may send one corrected receipt.`,
      payload: JSON.stringify({
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        lifecycleAdapter: 'container-file',
        rejection: reason
      })
    })
    args.notify(message.to_handle, message.type)
  } catch (notificationError) {
    if (!existsSync(resultPath) && existsSync(rejectedPath)) {
      renameSync(rejectedPath, resultPath)
    }
    throw notificationError
  }
}

export function monitorWorkerContainerLifecycle(
  args: Parameters<typeof admitWorkerContainerLifecycleReceipt>[0]
): void {
  const deadline = Date.now() + LIFECYCLE_MONITOR_MS
  let unreadableWarningEmitted = false
  const poll = (): boolean => {
    try {
      return admitWorkerContainerLifecycleReceipt(args) === 'settled'
    } catch (error) {
      if (isWorkerLifecycleReceiptUnreadable(error)) {
        if (!unreadableWarningEmitted) {
          console.warn(
            '[orchestration] retrying unreadable receipt',
            args.dispatchId,
            error.message
          )
        }
        unreadableWarningEmitted = true
        return false
      }
      console.warn(
        `[orchestration] rejected container lifecycle receipt for ${args.dispatchId}`,
        error instanceof Error ? error.message : error
      )
      try {
        quarantineRejectedLifecycleReceipt(args, error)
      } catch (quarantineError) {
        console.warn(
          `[orchestration] failed to quarantine container lifecycle receipt for ${args.dispatchId}`,
          quarantineError instanceof Error ? quarantineError.message : quarantineError
        )
      }
      return false
    }
  }
  if (poll()) {
    return
  }
  const timer = setInterval(() => {
    if (Date.now() >= deadline || poll()) {
      clearInterval(timer)
    }
  }, LIFECYCLE_POLL_MS)
  timer.unref()
}

export function restoreWorkerContainerLifecycleMonitors(args: {
  db: OrchestrationDb
  notify: (handle: string, messageType?: string) => void
}): void {
  // Some embedding/tests provide a deliberately narrow DB adapter. Absence is not evidence of
  // retained container work, so recovery is inapplicable; the production DB always owns this API.
  if (typeof args.db.listLegacyWorkerTerminalRecoveryRows !== 'function') {
    return
  }
  for (const row of args.db.listLegacyWorkerTerminalRecoveryRows()) {
    try {
      if (
        row.worker_state !== 'ready' ||
        row.dispatch_status !== 'dispatched' ||
        !row.assignee_handle
      ) {
        continue
      }
      const worker = args.db.getWorkerDispatch(row.dispatch_id)
      if (!worker) {
        continue
      }
      let startOptions: Record<string, unknown>
      try {
        startOptions = JSON.parse(worker.start_options) as Record<string, unknown>
      } catch {
        continue
      }
      const attestation = startOptions.authorityIsolation as
        | { capabilityRef?: unknown; runId?: unknown; taskId?: unknown; dispatchId?: unknown }
        | undefined
      if (
        typeof attestation?.capabilityRef !== 'string' ||
        typeof attestation.runId !== 'string' ||
        typeof attestation.taskId !== 'string' ||
        attestation.dispatchId !== row.dispatch_id
      ) {
        continue
      }
      const lifecycle = createWorkerContainerLifecycleBoundary({
        dispatchId: row.dispatch_id,
        capabilityRef: attestation.capabilityRef
      })
      monitorWorkerContainerLifecycle({
        db: args.db,
        runId: attestation.runId,
        taskId: attestation.taskId,
        dispatchId: row.dispatch_id,
        terminalHandle: row.assignee_handle,
        lifecycle,
        notify: args.notify
      })
    } catch (error) {
      console.warn(
        `[orchestration] failed to restore container lifecycle for ${row.dispatch_id}`,
        error instanceof Error ? error.message : error
      )
    }
  }
}
