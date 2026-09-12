import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'

const RUNTIME_IDENTITY_VERSION = 1 as const
const MAX_RUNTIME_ID_BYTES = 256

type PersistedRuntimeIdentity = Readonly<{
  version: typeof RUNTIME_IDENTITY_VERSION
  runtimeId: string
}>

/** Returns the profile identity used to fence durable runtime-owned journals across restarts. */
export function loadOrCreateRuntimeIdentity(path: string): string {
  if (existsSync(path)) {
    return parsePersistedRuntimeIdentity(readFileSync(path, 'utf8'))
  }
  const runtimeId = randomUUID()
  const persisted: PersistedRuntimeIdentity = { version: RUNTIME_IDENTITY_VERSION, runtimeId }
  writeDurableSecureJsonFile(path, persisted)
  return runtimeId
}

function parsePersistedRuntimeIdentity(contents: string): string {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new Error('runtime_identity_invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime_identity_invalid')
  }
  const record = value as { version?: unknown; runtimeId?: unknown }
  if (
    record.version !== RUNTIME_IDENTITY_VERSION ||
    typeof record.runtimeId !== 'string' ||
    record.runtimeId.length === 0 ||
    Buffer.byteLength(record.runtimeId, 'utf8') > MAX_RUNTIME_ID_BYTES
  ) {
    throw new Error('runtime_identity_invalid')
  }
  return record.runtimeId
}
