// Persist the iroh endpoint secret so EndpointId stays stable across restarts.
import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../../shared/secure-file'

export const IROH_ENDPOINT_SECRET_FILENAME = 'orca-iroh-endpoint-secret.json'
const SECRET_VERSION = 1
const MAX_SECRET_FILE_BYTES = 4 * 1024
const SECRET_KEY_BYTES = 32

type SecretFile = {
  v: number
  secretKeyB64: string
}

/** Safe diagnostics never retain an I/O cause that could contain credential bytes. */
export class IrohEndpointSecretError extends Error {
  /** Identify the failed persistence stage without copying its underlying error. */
  constructor(readonly operation: 'read' | 'write') {
    super(
      operation === 'read'
        ? 'Cannot read the Iroh endpoint secret; refusing to replace the identity used by paired phones.'
        : 'Cannot write the Iroh endpoint secret; endpoint identity could not be saved.'
    )
    this.name = 'IrohEndpointSecretError'
  }
}

/** Read at most the size limit plus one byte; only a missing open permits creation. */
function readSavedSecret(filePath: string): Buffer | null {
  let descriptor: number
  try {
    descriptor = openSync(filePath, 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw new IrohEndpointSecretError('read')
  }
  try {
    try {
      hardenExistingSecureFile(filePath)
      const contents = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1)
      let size = 0
      while (size < contents.length) {
        const count = readSync(descriptor, contents, size, contents.length - size, null)
        if (count === 0) {
          break
        }
        size += count
      }
      return contents.subarray(0, size)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    throw new IrohEndpointSecretError('read')
  }
}

/** Reuse readable valid identities; repair invalid data, but fail closed on every I/O error. */
export function loadOrCreateIrohEndpointSecret(userDataPath: string): number[] {
  const filePath = join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME)

  const saved = readSavedSecret(filePath)
  if (saved !== null) {
    try {
      const raw: Partial<Record<keyof SecretFile, unknown>> =
        saved.length > MAX_SECRET_FILE_BYTES ? {} : JSON.parse(saved.toString('utf-8'))
      if (raw.v === SECRET_VERSION && typeof raw.secretKeyB64 === 'string') {
        const bytes = Array.from(Buffer.from(raw.secretKeyB64, 'base64'))
        if (bytes.length === SECRET_KEY_BYTES) {
          return bytes
        }
      }
    } catch {
      // Successfully read malformed JSON is repairable; never log its parse error.
    }
    // Why: a new secret means a new EndpointId — every paired phone's stored
    // dial target goes stale, so the cause must be visible in logs.
    console.warn('[iroh-transport] endpoint secret file was invalid; generating a new identity')
  }

  // Why: generate via crypto so we can persist before loading the native iroh module.
  const bytes = Array.from(randomBytes(SECRET_KEY_BYTES))
  try {
    writeSecureJsonFile(filePath, {
      v: SECRET_VERSION,
      secretKeyB64: Buffer.from(bytes).toString('base64')
    } satisfies SecretFile)
  } catch {
    throw new IrohEndpointSecretError('write')
  }
  return bytes
}
