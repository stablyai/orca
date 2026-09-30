// Persist the iroh endpoint secret so EndpointId stays stable across restarts.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
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

export function loadOrCreateIrohEndpointSecret(userDataPath: string): number[] {
  const filePath = join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME)

  const hadExistingFile = existsSync(filePath)
  if (hadExistingFile) {
    try {
      hardenExistingSecureFile(filePath)
      if (statSync(filePath).size > MAX_SECRET_FILE_BYTES) {
        throw new Error('iroh endpoint secret file is too large')
      }
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as SecretFile
      if (raw.v === SECRET_VERSION && typeof raw.secretKeyB64 === 'string') {
        const bytes = Array.from(Buffer.from(raw.secretKeyB64, 'base64'))
        if (bytes.length === SECRET_KEY_BYTES) {
          return bytes
        }
      }
    } catch {
      // Malformed file — regenerate below.
    }
    // Why: a new secret means a new EndpointId — every paired phone's stored
    // dial target goes stale, so the cause must be visible in logs.
    console.warn('[iroh-transport] endpoint secret file was invalid; generating a new identity')
  }

  // Why: generate via crypto so we can persist before loading the native iroh module.
  const bytes = Array.from(randomBytes(SECRET_KEY_BYTES))
  writeSecureJsonFile(filePath, {
    v: SECRET_VERSION,
    secretKeyB64: Buffer.from(bytes).toString('base64')
  } satisfies SecretFile)
  return bytes
}
