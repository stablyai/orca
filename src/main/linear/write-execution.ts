import type { LinearClient } from '@linear/sdk'
import { loadLinearSdk } from './linear-sdk'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { isAuthError, type LinearClientForWorkspace } from './client'

export type LinearWriteFailureKind = 'duplicate_id' | 'failed' | 'network' | 'unconfirmed'

export class LinearWriteFailure extends Error {
  readonly kind: LinearWriteFailureKind
  readonly cause: unknown

  constructor(kind: LinearWriteFailureKind, message: string, cause?: unknown) {
    super(message)
    this.name = 'LinearWriteFailure'
    this.kind = kind
    this.cause = cause
  }
}

function linearWriteMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isDuplicateIdError(error: unknown): boolean {
  const message = linearWriteMessage(error).toLowerCase()
  return (
    message.includes('duplicate') ||
    message.includes('already exists') ||
    message.includes('already in use') ||
    message.includes('id has already')
  )
}

function errorCauseCode(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return ''
  }
  const cause = (error as { cause?: unknown }).cause
  if (!cause || typeof cause !== 'object') {
    return ''
  }
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' ? code.toLowerCase() : ''
}

export function classifyLinearWriteFailure(error: unknown): LinearWriteFailure {
  if (error instanceof LinearWriteFailure) {
    return error
  }
  if (isDuplicateIdError(error)) {
    return new LinearWriteFailure('duplicate_id', linearWriteMessage(error), error)
  }
  const message = linearWriteMessage(error)
  const lower = message.toLowerCase()
  const code = errorCauseCode(error)
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    code === 'enotfound' ||
    code === 'econnrefused'
  ) {
    return new LinearWriteFailure('network', message, error)
  }
  if (
    lower.includes('abort') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed') ||
    lower.includes('socket')
  ) {
    return new LinearWriteFailure('unconfirmed', message, error)
  }
  return new LinearWriteFailure('failed', message, error)
}

/** The SDK only accepts an AbortSignal at construction time. */
export function linearWriteClient(
  entry: LinearClientForWorkspace,
  signal: AbortSignal | undefined
): LinearClient {
  return signal
    ? new (loadLinearSdk().LinearClient)({ apiKey: entry.apiKey, signal })
    : entry.client
}

export async function runLinearWrite<T>(
  entry: LinearClientForWorkspace,
  signal: AbortSignal | undefined,
  write: (client: LinearClient) => Promise<T>
): Promise<T> {
  await acquire()
  try {
    return await write(linearWriteClient(entry, signal))
  } catch (error) {
    if (error instanceof LinearWriteFailure) {
      throw error
    }
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    throw classifyLinearWriteFailure(error)
  } finally {
    release()
  }
}

export async function runLinearLookup<T>(
  entry: LinearClientForWorkspace,
  lookup: () => Promise<T>
): Promise<T | null> {
  await acquire()
  try {
    return await lookup()
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    if (isLinearLookupMiss(error)) {
      return null
    }
    throw error
  } finally {
    release()
  }
}

export function isLinearLookupMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // Why: Linear throws for direct entity lookups that miss; write-id probes
  // need the same null shape as GraphQL nullable data, not a failed write.
  return message.includes('Entity not found:') && message.includes('Could not find referenced')
}

export async function confirmLinearWrite<T>(
  message: string,
  readback: () => Promise<T>
): Promise<T> {
  try {
    return await readback()
  } catch (error) {
    throw new LinearWriteFailure('unconfirmed', message, error)
  }
}
