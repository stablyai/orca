import {
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { parseHangStacks, type HangStacks } from './hang-stacks'
import { resolveObservabilityConsent } from '../observability'
import { hasActiveTraceSink } from '../observability/tracer'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { hangCaptureDetails } from './hang-capture-details'

export type RendererHangRecord = HangStacks & {
  id: string
  parentPid: number
  windowId: number
  detectedAt: number
  completedAt?: number
  status:
    | 'collecting'
    | 'captured'
    | 'unavailable'
    | 'policy-missing'
    | 'failed'
    | 'process-capture-pending'
    | 'stopped'
}
const validStatus = [
  'collecting',
  'captured',
  'unavailable',
  'policy-missing',
  'failed',
  'process-capture-pending',
  'stopped'
]
let current: RendererHangRecord[] = []

function pathFor(userDataPath: string, previous = false): string {
  return join(userDataPath, `renderer-hang.json${previous ? '.previous' : ''}`)
}
function parseRecord(value: unknown): RendererHangRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding branch excludes null and non-objects before reading unknown properties.
  const data = value as Record<string, unknown>
  const stacks = parseHangStacks(data)
  if (
    !stacks ||
    typeof data.id !== 'string' ||
    !/^[\d:.-]{1,80}$/.test(data.id) ||
    !validStatus.includes(String(data.status))
  ) {
    return null
  }
  for (const key of ['parentPid', 'windowId', 'detectedAt'] as const) {
    if (typeof data[key] !== 'number' || !Number.isSafeInteger(data[key]) || data[key] < 0) {
      return null
    }
  }
  return {
    ...stacks,
    id: data.id,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding numeric-field loop validates these finite nonnegative integer fields.
    parentPid: data.parentPid as number,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding numeric-field loop validates these finite nonnegative integer fields.
    windowId: data.windowId as number,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding numeric-field loop validates these finite nonnegative integer fields.
    detectedAt: data.detectedAt as number,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixed state allowlist above validates this string union.
    status: data.status as RendererHangRecord['status'],
    ...(typeof data.completedAt === 'number' &&
    Number.isSafeInteger(data.completedAt) &&
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding numeric-field loop validates these finite nonnegative integer fields.
    data.completedAt >= (data.detectedAt as number)
      ? { completedAt: data.completedAt }
      : {})
  }
}
function read(path: string): RendererHangRecord[] | undefined {
  try {
    if (statSync(path).size > 16 * 1024) {
      return []
    }
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !data ||
      typeof data !== 'object' ||
      !('version' in data) ||
      data.version !== 1 ||
      !('records' in data) ||
      !Array.isArray(data.records) ||
      data.records.length > 4
    ) {
      return []
    }
    return data.records.map(parseRecord).filter((item): item is RendererHangRecord => item !== null)
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      ? []
      : undefined
  }
}
function admit(record: RendererHangRecord): RendererHangRecord {
  const candidate = structuredClone(record)
  const bytes = (): number => Buffer.byteLength(JSON.stringify(candidate))
  while (bytes() > 3 * 1024 && candidate.stacks.length > 1) {
    candidate.stacks.pop()
    candidate.truncated = true
  }
  while (bytes() > 3 * 1024 && candidate.stacks[0]?.frames.length > 1) {
    candidate.stacks[0].frames.pop()
    candidate.truncated = true
  }
  if (bytes() > 3 * 1024) {
    for (const frame of candidate.stacks[0]?.frames ?? []) {
      frame.name = frame.name.slice(0, 24)
      frame.module = frame.module.slice(0, 24)
      candidate.truncated = true
    }
  }
  return candidate
}
function merge(first: RendererHangRecord[], second: RendererHangRecord[]): RendererHangRecord[] {
  const records = new Map<string, RendererHangRecord>()
  for (const item of [...first, ...second]) {
    const key = `${item.parentPid}:${item.windowId}`
    const old = records.get(key)
    if (!old || item.detectedAt >= old.detectedAt) {
      records.set(key, admit(item))
    }
  }
  return [...records.values()].sort((a, b) => a.detectedAt - b.detectedAt).slice(-4)
}
function write(path: string, records: RendererHangRecord[]): void {
  const text = JSON.stringify({ version: 1, records })
  if (Buffer.byteLength(text) > 16 * 1024) {
    throw new Error('Renderer hang records exceed byte bound')
  }
  const fd = openSync(`${path}.tmp`, 'w', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
  renameSync(`${path}.tmp`, path)
}

export function publishRendererHang(userDataPath: string, record: RendererHangRecord): void {
  if (!resolveObservabilityConsent().localFileEnabled) {
    return
  }
  try {
    const normalized = parseRecord(record)
    if (!normalized) {
      return
    }
    const disk = read(pathFor(userDataPath))
    if (!disk) {
      return
    }
    current = merge(merge(disk, current), [normalized])
    write(pathFor(userDataPath), current)
  } catch {
    /* Optional diagnostics never block a window lifecycle event. */
  }
}

export function preservePreviousRendererHangs(userDataPath: string): void {
  if (!resolveObservabilityConsent().localFileEnabled) {
    return
  }
  try {
    const records = read(pathFor(userDataPath))
    if (!records?.length) {
      return
    }
    const previous = read(pathFor(userDataPath, true))
    if (!previous) {
      return
    }
    write(pathFor(userDataPath, true), merge(previous, records))
    rmSync(pathFor(userDataPath), { force: true })
    current = []
  } catch {
    /* Keep the original pending file if preservation failed. */
  }
}

export function reportPreviousRendererHangs(userDataPath: string): void {
  if (!resolveObservabilityConsent().localFileEnabled || !hasActiveTraceSink()) {
    return
  }
  try {
    const records = read(pathFor(userDataPath, true))
    if (!records) {
      return
    }
    for (const record of records) {
      recordDurableCrashBreadcrumb('renderer_hang_capture', {
        previousPid: record.parentPid,
        windowId: record.windowId,
        detectedAt: record.detectedAt,
        completedAt: record.completedAt ?? null,
        ...hangCaptureDetails('rendererJs', record)
      })
    }
    // Each breadcrumb synchronously requests a trace flush before pending data is consumed.
    rmSync(pathFor(userDataPath, true), { force: true })
  } catch {
    /* A failed replay remains pending for next launch. */
  }
}
