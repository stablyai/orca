import { statSync } from 'node:fs'
import { z } from 'zod'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { normalizeEndpointAuthHeaders } from '../../shared/network/endpoint-auth-headers'
import { remoteRuntimeConnectOptions } from '../../shared/remote-runtime-connect-bound'
import { loadWindowsSecurity } from '../../shared/windows-security-addon'
import { findSecureDaclViolation } from '../../shared/windows-secure-dacl'
import { RuntimeClientError } from './types'

const FileSchema = z
  .object({
    v: z.literal(1),
    origin: z.string(),
    hostPublicKeyB64: z.string(),
    headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()).max(8)
  })
  .strict()

export function readRemoteEdgeAuthFile(
  filePath: string,
  connection: PairedRuntimeConnection
): NonNullable<PairedRuntimeConnection['edgeAuth']> {
  try {
    const { buffer, stats } = readNodeFileSyncWithinLimit(filePath, 32768, {
      regularFileOnly: true
    })
    if (process.platform === 'win32') {
      const security = loadWindowsSecurity()
      if (
        'error' in security ||
        findSecureDaclViolation(security.addon.getDaclAces(filePath), security.userSid, false)
      ) {
        throw new Error('Unsafe permissions')
      }
      const current = statSync(filePath)
      if (
        current.dev !== stats.dev ||
        current.ino !== stats.ino ||
        current.ctimeMs !== stats.ctimeMs ||
        current.size !== stats.size
      ) {
        throw new Error('Credential file changed')
      }
    } else if (stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) {
      throw new Error('Unsafe permissions')
    }
    const input = FileSchema.parse(JSON.parse(buffer.toString('utf8')))
    const normalized = normalizeEndpointAuthHeaders(input.headers)
    if (!normalized.ok || Object.keys(normalized.headers).length === 0) {
      throw new Error('Invalid headers')
    }
    const edgeAuth = {
      origin: input.origin,
      hostPublicKeyB64: input.hostPublicKeyB64,
      headers: normalized.headers
    }
    remoteRuntimeConnectOptions(undefined, undefined, { ...connection, edgeAuth })
    return edgeAuth
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid remote edge authentication file. Use a private file bound to this secure origin and host identity.'
    )
  }
}
