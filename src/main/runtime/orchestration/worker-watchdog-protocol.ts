export const WORKER_WATCHDOG_CLEANUP_GRACE_MS = 10_000 as const

export type WorkerWatchdogRequest = {
  dispatchId: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  deadlineAt: string
  cleanupGraceMs: typeof WORKER_WATCHDOG_CLEANUP_GRACE_MS
  sentinelPath: string
}

export type WorkerWatchdogSentinel = {
  dispatchId: string
  startedAt: string
  deadlineAt: string
  finishedAt: string
  exitCode: number | null
  signal: string | null
  stop: 'natural' | 'shutdown' | 'term' | 'kill' | 'tree_kill' | 'tree_kill_unknown'
}

export type WorkerWatchdogStartedReceipt = {
  dispatchId: string
  watchdogPid: number
  providerPid: number
  processGroupId: number | null
  sentinelPath: string
}

function isPlainStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((entry) => typeof entry === 'string')
}

export function parseWorkerWatchdogRequest(value: unknown): WorkerWatchdogRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Worker watchdog request must be an object.')
  }
  const input = value as Partial<WorkerWatchdogRequest>
  const deadlineMs =
    typeof input.deadlineAt === 'string' ? Date.parse(input.deadlineAt) : Number.NaN
  if (
    typeof input.dispatchId !== 'string' ||
    !/^ctx_[a-z0-9_]+$/.test(input.dispatchId) ||
    typeof input.command !== 'string' ||
    input.command.length === 0 ||
    !Array.isArray(input.args) ||
    !input.args.every((arg) => typeof arg === 'string') ||
    typeof input.cwd !== 'string' ||
    input.cwd.length === 0 ||
    !isPlainStringRecord(input.env) ||
    !Number.isFinite(deadlineMs) ||
    new Date(deadlineMs).toISOString() !== input.deadlineAt ||
    input.cleanupGraceMs !== WORKER_WATCHDOG_CLEANUP_GRACE_MS ||
    typeof input.sentinelPath !== 'string' ||
    input.sentinelPath.length === 0
  ) {
    throw new Error('Worker watchdog request is malformed.')
  }
  return input as WorkerWatchdogRequest
}

export function parseWorkerWatchdogStartedReceipt(value: unknown): WorkerWatchdogStartedReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Worker watchdog start receipt is malformed.')
  }
  const receipt = value as Partial<WorkerWatchdogStartedReceipt>
  if (
    typeof receipt.dispatchId !== 'string' ||
    !Number.isInteger(receipt.watchdogPid) ||
    (receipt.watchdogPid as number) <= 0 ||
    !Number.isInteger(receipt.providerPid) ||
    (receipt.providerPid as number) <= 0 ||
    !(
      receipt.processGroupId === null ||
      (Number.isInteger(receipt.processGroupId) && (receipt.processGroupId as number) > 0)
    ) ||
    typeof receipt.sentinelPath !== 'string' ||
    receipt.sentinelPath.length === 0
  ) {
    throw new Error('Worker watchdog start receipt is malformed.')
  }
  return receipt as WorkerWatchdogStartedReceipt
}

export function parseWorkerWatchdogSentinel(value: unknown): WorkerWatchdogSentinel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Worker watchdog sentinel is malformed.')
  }
  const sentinel = value as Partial<WorkerWatchdogSentinel>
  const timestamps = [sentinel.startedAt, sentinel.deadlineAt, sentinel.finishedAt]
  if (
    typeof sentinel.dispatchId !== 'string' ||
    sentinel.dispatchId.length === 0 ||
    !timestamps.every(
      (timestamp) =>
        typeof timestamp === 'string' &&
        Number.isFinite(Date.parse(timestamp)) &&
        new Date(Date.parse(timestamp)).toISOString() === timestamp
    ) ||
    !(
      sentinel.exitCode === null ||
      (Number.isInteger(sentinel.exitCode) && Number.isSafeInteger(sentinel.exitCode))
    ) ||
    !(sentinel.signal === null || typeof sentinel.signal === 'string') ||
    !['natural', 'shutdown', 'term', 'kill', 'tree_kill', 'tree_kill_unknown'].includes(
      sentinel.stop as string
    )
  ) {
    throw new Error('Worker watchdog sentinel is malformed.')
  }
  return sentinel as WorkerWatchdogSentinel
}
