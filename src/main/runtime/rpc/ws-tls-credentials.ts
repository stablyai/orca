// The certificate and key `orca serve --tls-cert/--tls-key` serves https:// and wss:// with.
import { readFileSync, statSync } from 'node:fs'
import type { Server as HttpsServer } from 'node:https'
import { createSecureContext } from 'node:tls'

export type WsTlsFiles = { certPath: string; keyPath: string }
export type WsTlsCredentials = { cert: Buffer; key: Buffer }

const RELOAD_CHECK_INTERVAL_MS = 60 * 60_000

export class WsTlsCredentialsError extends Error {
  readonly code = 'invalid_tls_credentials'
}

/** Throws when the files are unreadable or the key does not match the certificate. */
export function readWsTlsCredentials(files: WsTlsFiles): WsTlsCredentials {
  try {
    const credentials = {
      cert: readFileSync(files.certPath),
      key: readFileSync(files.keyPath)
    }
    createSecureContext(credentials)
    return credentials
  } catch (error) {
    throw new WsTlsCredentialsError(
      `Could not load the TLS certificate ${files.certPath} with key ${files.keyPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}

/**
 * Why: certificates such as Let's Encrypt's are renewed in place; swapping the context picks up
 * the new pair for later handshakes without restarting serve or dropping connected clients.
 */
export function watchWsTlsCredentials(
  server: HttpsServer,
  files: WsTlsFiles,
  intervalMs = RELOAD_CHECK_INTERVAL_MS
): () => void {
  let stamp = readStamp(files)
  const timer = setInterval(() => {
    const next = readStamp(files)
    if (next === null || next === stamp) {
      return
    }
    try {
      server.setSecureContext(readWsTlsCredentials(files))
      stamp = next
      console.warn(`[ws-transport] reloaded TLS certificate ${files.certPath}`)
    } catch (error) {
      console.warn(
        `[ws-transport] keeping the previous TLS certificate: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

function readStamp(files: WsTlsFiles): string | null {
  try {
    return `${statSync(files.certPath).mtimeMs}:${statSync(files.keyPath).mtimeMs}`
  } catch {
    return null
  }
}
