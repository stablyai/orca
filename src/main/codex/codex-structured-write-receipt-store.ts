import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'
import type {
  CodexStructuredWriteAdmissionReceipt,
  CodexStructuredWriteReceipt
} from './codex-structured-write-types'

const ADMISSION_FILE = 'host-enforcement-receipts.json'
const TRACE_FILE = 'operational-trace.json'
const MAX_RECEIPTS = 100_000
const MAX_MANIFEST_ENTRIES = 128
const SHA256_PATTERN = /^[0-9a-f]{64}$/

type AdmissionState = {
  protocolVersion: 1
  receipts: CodexStructuredWriteAdmissionReceipt[]
}

type TraceState = {
  protocolVersion: 1
  receipts: CodexStructuredWriteReceipt[]
}

/** Durable host evidence. Admission commits synchronously before mutation;
 * outcome trace is queued separately and is never an execution prerequisite. */
export class CodexStructuredWriteReceiptStore {
  private admissionWrite: Promise<void> = Promise.resolve()
  private traceWrite: Promise<void> = Promise.resolve()
  private readonly admittedMessages = new Set<string>()

  private constructor(
    private readonly admissionPath: string,
    private readonly tracePath: string,
    private readonly admissions: AdmissionState,
    private readonly traces: TraceState
  ) {
    for (const receipt of admissions.receipts) {
      this.admittedMessages.add(messageKey(receipt.sessionId, receipt.clientMessageId))
    }
  }

  static async open(
    directory: string,
    onTraceError?: (error: unknown) => void
  ): Promise<CodexStructuredWriteReceiptStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const admissionPath = join(directory, ADMISSION_FILE)
    const tracePath = join(directory, TRACE_FILE)
    return new CodexStructuredWriteReceiptStore(
      admissionPath,
      tracePath,
      await loadState(admissionPath, isAdmissionReceipt),
      await loadOptionalTraceState(tracePath, onTraceError)
    )
  }

  hasAdmission(sessionId: string, clientMessageId: string): boolean {
    return this.admittedMessages.has(messageKey(sessionId, clientMessageId))
  }

  persistAdmission(receipt: CodexStructuredWriteAdmissionReceipt): Promise<void> {
    const key = messageKey(receipt.sessionId, receipt.clientMessageId)
    const operation = this.admissionWrite.then(async () => {
      if (this.admittedMessages.has(key)) {
        throw new Error('structured write operation already has a durable admission receipt')
      }
      if (this.admissions.receipts.length >= MAX_RECEIPTS) {
        throw new Error('structured write admission receipt capacity reached')
      }
      const next: AdmissionState = {
        protocolVersion: 1,
        receipts: [...this.admissions.receipts, structuredClone(receipt)]
      }
      await writeFileDurable(
        durableWriteTempPath(this.admissionPath),
        this.admissionPath,
        `${JSON.stringify(next)}\n`
      )
      this.admissions.receipts = next.receipts
      this.admittedMessages.add(key)
    })
    this.admissionWrite = operation.catch(() => {})
    return operation
  }

  persistOutcome(receipt: CodexStructuredWriteReceipt): Promise<void> {
    const operation = this.traceWrite.then(async () => {
      if (this.traces.receipts.length >= MAX_RECEIPTS) {
        this.traces.receipts = this.traces.receipts.slice(-Math.trunc(MAX_RECEIPTS / 2))
      }
      const next: TraceState = {
        protocolVersion: 1,
        receipts: [...this.traces.receipts, structuredClone(receipt)]
      }
      await writeFileDurable(
        durableWriteTempPath(this.tracePath),
        this.tracePath,
        `${JSON.stringify(next)}\n`
      )
      this.traces.receipts = next.receipts
    })
    this.traceWrite = operation.catch(() => {})
    return operation
  }

  async flush(): Promise<void> {
    await this.admissionWrite
    await this.traceWrite
  }
}

async function loadOptionalTraceState(
  path: string,
  onTraceError?: (error: unknown) => void
): Promise<TraceState> {
  try {
    return await loadState(path, isOutcomeReceipt)
  } catch (error) {
    onTraceError?.(error)
    return { protocolVersion: 1, receipts: [] }
  }
}

async function loadState<T>(
  path: string,
  isReceipt: (value: unknown) => value is T
): Promise<{ protocolVersion: 1; receipts: T[] }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { protocolVersion: 1, receipts: [] }
    }
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || parsed.protocolVersion !== 1 || !Array.isArray(parsed.receipts)) {
    throw new Error('structured write receipt store is unreadable')
  }
  if (parsed.receipts.length > MAX_RECEIPTS || !parsed.receipts.every(isReceipt)) {
    throw new Error('structured write receipt store contains invalid receipts')
  }
  return { protocolVersion: 1, receipts: parsed.receipts }
}

function isAdmissionReceipt(value: unknown): value is CodexStructuredWriteAdmissionReceipt {
  return (
    isBaseReceipt(value) &&
    isManifest(value.before) &&
    isNonNegativeFiniteNumber(value.admittedAtMs)
  )
}

function isOutcomeReceipt(value: unknown): value is CodexStructuredWriteReceipt {
  return (
    isBaseReceipt(value) &&
    isNonEmptyString(value.receiptId) &&
    isManifest(value.before) &&
    isManifest(value.after) &&
    ['completed', 'failed', 'declined'].includes(String(value.outcome)) &&
    isNonNegativeFiniteNumber(value.completedAtMs)
  )
}

function isBaseReceipt(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.protocolVersion === 1 &&
    value.effectDomain === 'local_structured_write' &&
    isSha256(value.requestReceiptId) &&
    isNonEmptyString(value.sessionId) &&
    isPositiveInteger(value.turnEpoch) &&
    isNonNegativeInteger(value.fence) &&
    isNonEmptyString(value.clientMessageId) &&
    isNonEmptyString(value.threadId) &&
    isNonEmptyString(value.turnId) &&
    isSha256(value.requestDigest) &&
    isNonEmptyString(value.toolUseId) &&
    isSha256(value.changePlanDigest) &&
    isNonEmptyString(value.worktreeRoot) &&
    isSha256(value.capabilityHandleDigest)
  )
}

function isManifest(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MANIFEST_ENTRIES &&
    value.every((entry) => {
      if (!isRecord(entry) || !isNonEmptyString(entry.path) || typeof entry.exists !== 'boolean') {
        return false
      }
      return entry.exists
        ? isSha256(entry.sha256) && isNonNegativeInteger(entry.bytes)
        : entry.sha256 === null && entry.bytes === null
    })
  )
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function messageKey(sessionId: string, clientMessageId: string): string {
  return `${sessionId.length}:${sessionId}${clientMessageId}`
}
