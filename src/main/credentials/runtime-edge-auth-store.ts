import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getSecretStore } from '../../shared/secret-store'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeSecureFile } from '../../shared/secure-file'
import {
  endpointAuthOrigin,
  normalizeEndpointAuthHeaders,
  type EndpointAuthHeaders
} from '../../shared/network/endpoint-auth-headers'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { remoteRuntimeConnectOptions } from '../../shared/remote-runtime-connect-bound'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'

type EdgeAuth = NonNullable<PairedRuntimeConnection['edgeAuth']>
const connectionCredentials = new Map<string, { identity: string; edgeAuth: EdgeAuth | null }>()
const EnvelopeSchema = z
  .object({ v: z.literal(1), ciphertext: z.string().min(1).max(32768) })
  .strict()
const PayloadSchema = z
  .object({
    v: z.literal(1),
    environmentId: z.string(),
    origin: z.string(),
    hostPublicKeyB64: z.string(),
    headers: z.record(z.string(), z.string())
  })
  .strict()

function credentialPath(userDataPath: string, environmentId: string): string {
  return join(
    userDataPath,
    'runtime-edge-auth',
    `${createHash('sha256').update(environmentId).digest('hex')}.json`
  )
}

function protectedStore() {
  const store = getSecretStore()
  if (!store.isEncryptionAvailable() || store.describeProtectionGap() !== null) {
    throw new Error('Protected storage unavailable')
  }
  return store
}

export function forgetRuntimeEdgeAuth(environmentId: string): void {
  connectionCredentials.delete(environmentId)
}

export function readCachedRuntimeEdgeAuth(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): EdgeAuth | null {
  const identity = JSON.stringify([
    userDataPath,
    environment.pairingRevision ?? environment.createdAt,
    getPreferredPairedRuntimeConnection(environment)
  ])
  const cached = connectionCredentials.get(environment.id)
  if (cached?.identity === identity) {
    return cached.edgeAuth
  }
  const edgeAuth = readRuntimeEdgeAuth(userDataPath, environment)
  connectionCredentials.set(environment.id, { identity, edgeAuth })
  return edgeAuth
}

export function readRuntimeEdgeAuth(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): EdgeAuth | null {
  try {
    let raw: string
    try {
      raw = readNodeFileSyncWithinLimit(credentialPath(userDataPath, environment.id), 32768, {
        regularFileOnly: true
      }).buffer.toString('utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
    const envelope = EnvelopeSchema.parse(JSON.parse(raw))
    const cipher = Buffer.from(envelope.ciphertext, 'base64')
    if (cipher.toString('base64') !== envelope.ciphertext) {
      throw new Error('Invalid envelope')
    }
    const payload = PayloadSchema.parse(JSON.parse(protectedStore().decryptString(cipher)))
    if (payload.environmentId !== environment.id) {
      throw new Error('Wrong environment')
    }
    const edgeAuth = {
      origin: payload.origin,
      hostPublicKeyB64: payload.hostPublicKeyB64,
      headers: payload.headers
    }
    remoteRuntimeConnectOptions(undefined, undefined, {
      ...getPreferredPairedRuntimeConnection(environment),
      edgeAuth
    })
    return edgeAuth
  } catch {
    throw new Error(
      'Could not read edge authentication. Unlock protected storage or clear and replace the saved credentials.'
    )
  }
}

export function writeRuntimeEdgeAuth(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  headers: EndpointAuthHeaders
): void {
  try {
    // Refuse replacement of an existing envelope we cannot safely read.
    readRuntimeEdgeAuth(userDataPath, environment)
    const connection = getPreferredPairedRuntimeConnection(environment)
    const origin = endpointAuthOrigin(connection.endpoint)
    const normalized = normalizeEndpointAuthHeaders(
      Object.entries(headers).map(([name, value]) => ({ name, value }))
    )
    if (!origin || !normalized.ok) {
      throw new Error('Invalid headers')
    }
    const edgeAuth = {
      origin,
      hostPublicKeyB64: connection.hostPublicKeyB64,
      headers: normalized.headers
    }
    remoteRuntimeConnectOptions(undefined, undefined, { ...connection, edgeAuth })
    const ciphertext = protectedStore()
      .encryptString(JSON.stringify({ v: 1, environmentId: environment.id, ...edgeAuth }))
      .toString('base64')
    const contents = JSON.stringify({ v: 1, ciphertext })
    if (Buffer.byteLength(contents, 'utf8') > 32768) {
      throw new Error('Invalid envelope size')
    }
    // Publication can succeed before the final durability check throws.
    forgetRuntimeEdgeAuth(environment.id)
    writeSecureFile(credentialPath(userDataPath, environment.id), contents, {
      durable: true,
      requireRestricted: true
    })
  } catch {
    throw new Error(
      'Could not save edge authentication. Check the secure address and protected storage, or clear unreadable credentials first.'
    )
  }
}

export function clearRuntimeEdgeAuth(userDataPath: string, environmentId: string): void {
  try {
    rmSync(credentialPath(userDataPath, environmentId), { force: true })
    forgetRuntimeEdgeAuth(environmentId)
  } catch {
    throw new Error('Could not clear edge authentication.')
  }
}

export function getRuntimeEdgeAuthStatus(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): { configured: boolean; unreadable: boolean } {
  try {
    return {
      configured: readRuntimeEdgeAuth(userDataPath, environment) !== null,
      unreadable: false
    }
  } catch {
    return { configured: true, unreadable: true }
  }
}
