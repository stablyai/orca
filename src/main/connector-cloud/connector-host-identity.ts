// The machine's own key for Orca Cloud, separate from the pairing key so signing out never unpairs a phone.
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { z } from 'zod'
import { hardenExistingSecureFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import type { E2EEKeypair } from '../runtime/e2ee-keypair'
import { isMissingFileError } from '../runtime/device-registry-corruption'
import { deriveRelayHostId } from '../runtime/mobile-cloud-relay/relay-http-client'

const HOST_FILE = 'orca-cloud-host-key.json'
const MAX_HOST_FILE_BYTES = 4096

const HostFile = z.object({
  v: z.literal(1),
  secretKeyB64: z.base64(),
  hostId: z.string().min(1),
  email: z.string().min(1),
  hostName: z.string().min(1),
  linkedAt: z.number().int().positive()
})

export type ConnectorHostLink = Omit<z.infer<typeof HostFile>, 'v' | 'secretKeyB64'>
export type ConnectorHostIdentity = { keypair: E2EEKeypair; link: ConnectorHostLink }

export function keypairFromSecret(secretKey: Uint8Array): E2EEKeypair {
  const { publicKey } = nacl.box.keyPair.fromSecretKey(secretKey)
  return { publicKey, secretKey, publicKeyB64: Buffer.from(publicKey).toString('base64') }
}

/** The id the cloud knows this key by: push's host fingerprint. */
export function connectorHostId(keypair: E2EEKeypair): string {
  return deriveRelayHostId(keypair.publicKey)
}

/** Null when this machine was never linked or its file is not one this version wrote. */
export function readConnectorHostIdentity(userDataPath: string): ConnectorHostIdentity | null {
  const filePath = join(userDataPath, HOST_FILE)
  let raw: string
  try {
    hardenExistingSecureFile(filePath)
    if (statSync(filePath).size > MAX_HOST_FILE_BYTES) {
      return null
    }
    raw = readFileSync(filePath, 'utf-8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = HostFile.safeParse(json)
  if (!parsed.success) {
    return null
  }
  const { v: _v, secretKeyB64, ...link } = parsed.data
  const secretKey = Uint8Array.from(Buffer.from(secretKeyB64, 'base64'))
  return secretKey.length === nacl.box.secretKeyLength
    ? { keypair: keypairFromSecret(secretKey), link }
    : null
}

export function writeConnectorHostIdentity(
  userDataPath: string,
  identity: ConnectorHostIdentity
): void {
  writeDurableSecureJsonFile(join(userDataPath, HOST_FILE), {
    v: 1,
    secretKeyB64: Buffer.from(identity.keypair.secretKey).toString('base64'),
    ...identity.link
  })
}

export function deleteConnectorHostIdentity(userDataPath: string): void {
  rmSync(join(userDataPath, HOST_FILE), { force: true })
}
