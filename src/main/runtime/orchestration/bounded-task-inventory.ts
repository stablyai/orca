import { createHmac, timingSafeEqual } from 'node:crypto'
import type { TaskStatus } from './types'

const CURSOR_VERSION = 1
const MAX_CURSOR_LENGTH = 512
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export const BOUNDED_TASK_INVENTORY_CURSOR_ERROR = 'Invalid bounded task inventory cursor'

export type BoundedTaskInventoryTask = {
  id: string
  title: string
  status: TaskStatus
}

export type BoundedTaskInventoryPage = {
  tasks: BoundedTaskInventoryTask[]
  totalCount: number
  nextCursor: string | null
  truncated: boolean
}

export type BoundedTaskInventoryCursor = {
  version: typeof CURSOR_VERSION
  ceilingRowId: number
  anchorId: string
  totalCount: number
  lastRowId: number
}

type SignedBoundedTaskInventoryCursor = BoundedTaskInventoryCursor & {
  signature: string
}

export function createBoundedTaskInventoryCursor(
  cursor: BoundedTaskInventoryCursor,
  secret: Uint8Array
): string {
  const signed: SignedBoundedTaskInventoryCursor = {
    ...cursor,
    signature: signCursor(cursor, secret)
  }
  const encoded = Buffer.from(serializeSignedCursor(signed), 'utf8').toString('base64url')
  if (encoded.length > MAX_CURSOR_LENGTH) {
    throwInvalidCursor()
  }
  return encoded
}

export function parseBoundedTaskInventoryCursor(
  cursor: string,
  secret: Uint8Array
): BoundedTaskInventoryCursor {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(cursor)) {
    throwInvalidCursor()
  }

  let decoded: string
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) {
      throwInvalidCursor()
    }
    decoded = bytes.toString('utf8')
  } catch {
    throwInvalidCursor()
  }

  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    throwInvalidCursor()
  }

  if (!isSignedBoundedTaskInventoryCursor(value)) {
    throwInvalidCursor()
  }
  if (decoded !== serializeSignedCursor(value)) {
    throwInvalidCursor()
  }
  const { signature, ...unsigned } = value
  if (!hasValidSignature(unsigned, signature, secret)) {
    throwInvalidCursor()
  }
  return unsigned
}

function isSignedBoundedTaskInventoryCursor(
  value: unknown
): value is SignedBoundedTaskInventoryCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 6 ||
    keys.join(',') !== 'anchorId,ceilingRowId,lastRowId,signature,totalCount,version'
  ) {
    return false
  }
  return (
    record.version === CURSOR_VERSION &&
    isPositiveSafeInteger(record.ceilingRowId) &&
    typeof record.anchorId === 'string' &&
    record.anchorId.length > 0 &&
    record.anchorId.length <= 256 &&
    isPositiveSafeInteger(record.totalCount) &&
    isNonNegativeSafeInteger(record.lastRowId) &&
    record.lastRowId < record.ceilingRowId &&
    typeof record.signature === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(record.signature)
  )
}

function signCursor(cursor: BoundedTaskInventoryCursor, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(serializeCursor(cursor), 'utf8').digest('base64url')
}

function hasValidSignature(
  cursor: BoundedTaskInventoryCursor,
  signature: string,
  secret: Uint8Array
): boolean {
  const expected = signCursor(cursor, secret)
  return timingSafeEqual(Buffer.from(signature, 'ascii'), Buffer.from(expected, 'ascii'))
}

function serializeCursor(cursor: BoundedTaskInventoryCursor): string {
  return JSON.stringify({
    version: cursor.version,
    ceilingRowId: cursor.ceilingRowId,
    anchorId: cursor.anchorId,
    totalCount: cursor.totalCount,
    lastRowId: cursor.lastRowId
  })
}

function serializeSignedCursor(cursor: SignedBoundedTaskInventoryCursor): string {
  return JSON.stringify({
    version: cursor.version,
    ceilingRowId: cursor.ceilingRowId,
    anchorId: cursor.anchorId,
    totalCount: cursor.totalCount,
    lastRowId: cursor.lastRowId,
    signature: cursor.signature
  })
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function throwInvalidCursor(): never {
  throw new Error(BOUNDED_TASK_INVENTORY_CURSOR_ERROR)
}
