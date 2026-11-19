// This install's connector host key: proves to the auth service that a mint comes from the machine
// that owns the install id, so a leaked id alone can't act as this host. The Orca Cloud connector
// service verifies it.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject
} from 'node:crypto'
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { withFileTransactionLock } from '../filesystem/file-transaction-lock'

export const CONNECTOR_HOST_KEY_FILENAME = 'connector-host-key.json'
// Set per account when the cloud refused this key for it; that account's mints then ask to
// replace the key until the cloud accepts (it does only right after a fresh sign-in).
const RESET_PENDING_PREFIX = 'connector-host-key-reset-pending.'
const MAX_KEY_FILE_BYTES = 4 * 1024
const PROOF_CONTEXT = 'orca-connector-host-proof/v1'

const KeyFile = z.object({ privateKey: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/) }).strict()

export type ConnectorHostKey = { privateKey: KeyObject; publicKey: string }

export type ConnectorHostProof = {
  publicKey: string
  signedAt: number
  nonce: string
  signature: string
  reset?: true
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function fromPkcs8(encoded: string): ConnectorHostKey | null {
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(encoded, 'base64url'),
      format: 'der',
      type: 'pkcs8'
    })
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      return null
    }
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' })
    return typeof jwk.x === 'string' ? { privateKey, publicKey: jwk.x } : null
  } catch {
    return null
  }
}

async function readKey(filePath: string): Promise<ConnectorHostKey | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null
    }
    // Unreadable is not absent: a new key would lock this host out until a fresh sign-in.
    throw error
  }
  if (raw.length > MAX_KEY_FILE_BYTES) {
    return null
  }
  // A copy or restore may have loosened it; the key is only ever this user's.
  if (process.platform !== 'win32' && ((await stat(filePath)).mode & 0o077) !== 0) {
    await chmod(filePath, 0o600)
  }
  try {
    const parsed = KeyFile.safeParse(JSON.parse(raw))
    return parsed.success ? fromPkcs8(parsed.data.privateKey) : null
  } catch {
    return null
  }
}

/** Kept next to host-installation.json, never in the environment; every profile of the install shares it. */
export async function loadOrCreateConnectorHostKey(
  userDataPath: string
): Promise<ConnectorHostKey> {
  const filePath = join(userDataPath, CONNECTOR_HOST_KEY_FILENAME)
  const current = await readKey(filePath)
  if (current) {
    return current
  }
  return await withFileTransactionLock(filePath, async () => {
    const locked = await readKey(filePath)
    if (locked) {
      return locked
    }
    const { privateKey } = generateKeyPairSync('ed25519')
    const encoded = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
    const draftPath = `${filePath}.${randomBytes(8).toString('hex')}.draft`
    try {
      await writeFile(draftPath, JSON.stringify({ privateKey: encoded }), {
        flag: 'wx',
        mode: 0o600
      })
      await rename(draftPath, filePath)
    } finally {
      await rm(draftPath, { force: true })
    }
    const created = fromPkcs8(encoded)
    if (!created) {
      throw new Error('Could not read back the new connector host key')
    }
    return created
  })
}

export function signConnectorHostProof(
  key: ConnectorHostKey,
  options: { userId: string; machineId: string; signedAt: number; reset: boolean }
): ConnectorHostProof {
  const nonce = randomBytes(16).toString('base64url')
  const message = [
    PROOF_CONTEXT,
    options.userId,
    options.machineId,
    key.publicKey,
    String(options.signedAt),
    nonce,
    options.reset ? 'reset' : 'mint'
  ].join('\n')
  const signature = sign(null, Buffer.from(message), key.privateKey).toString('base64url')
  return {
    publicKey: key.publicKey,
    signedAt: options.signedAt,
    nonce,
    signature,
    ...(options.reset ? { reset: true as const } : {})
  }
}

function resetPendingPath(userDataPath: string, userId: string): string {
  const account = createHash('sha256').update(userId).digest('hex').slice(0, 16)
  return join(userDataPath, `${RESET_PENDING_PREFIX}${account}`)
}

export async function connectorHostKeyResetPending(
  userDataPath: string,
  userId: string
): Promise<boolean> {
  try {
    await readFile(resetPendingPath(userDataPath, userId))
    return true
  } catch {
    return false
  }
}

export async function setConnectorHostKeyResetPending(
  userDataPath: string,
  userId: string,
  pending: boolean
): Promise<void> {
  const filePath = resetPendingPath(userDataPath, userId)
  await (pending ? writeFile(filePath, '', { mode: 0o600 }) : rm(filePath, { force: true }))
}
