import { randomBytes } from 'node:crypto'
import { link, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import {
  getSecretStore,
  hasSecretStore,
  type SecretStore
} from '../../shared/secure-storage/secret-store'

const SECRET_FILE = 'mcp-server-set-key.sealed'
const SECRET_HEX = /^[0-9a-f]{64}$/

let secret: Promise<Buffer> | null = null

/**
 * This install's key for `mcpServerSetKey`: 32 random bytes kept in userData sealed by the OS
 * keychain through Orca's secret store, so the file itself needs no privacy. Where nothing can seal it, or it can't be read back, the key lives in memory for this
 * run alone: a kept agent's next launch then reads as changed and gets a fresh agent, which is
 * safe.
 */
export function mcpServerSetKeySecret(): Promise<Buffer> {
  secret ??= loadSecret().catch(() => randomBytes(32))
  return secret
}

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

function sealingStore(): SecretStore | null {
  if (!hasSecretStore()) {
    return null
  }
  const store = getSecretStore()
  const kind = store.describeSealing?.().kind
  // A host key is itself a file whose privacy can't be proven everywhere (macOS ACLs), and a mock
  // keychain (a test switch) seals with a fixed password, so only the real OS keychain seals this.
  const real = kind === 'os-keychain' && store.mockKeychain?.() !== true
  return store.isEncryptionAvailable() && real ? store : null
}

/** The kept secret, or null when there is none; throws when it can't be unsealed or is malformed. */
async function readSealed(store: SecretStore, path: string): Promise<Buffer | null> {
  let sealed: Buffer
  try {
    sealed = await readFile(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
  const kept = store.decryptString(sealed).trim()
  if (!SECRET_HEX.test(kept)) {
    throw new Error('MCP server set key secret is malformed')
  }
  return Buffer.from(kept, 'hex')
}

async function loadSecret(): Promise<Buffer> {
  const store = sealingStore()
  if (!store) {
    return randomBytes(32)
  }
  const path = join(getCanonicalUserDataPath(), SECRET_FILE)
  const kept = await readSealed(store, path)
  if (kept) {
    return kept
  }
  const fresh = randomBytes(32)
  const hex = fresh.toString('hex')
  const sealed = await (store.encryptStringAsync?.(hex) ??
    Promise.resolve(store.encryptString(hex)))
  const staging = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.staging`
  try {
    // Written whole, then linked in: no reader sees a partial file, and the first to link wins.
    await writeFile(staging, sealed)
    await link(staging, path)
    return fresh
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) {
      throw error
    }
    const winner = await readSealed(store, path)
    if (!winner) {
      throw error
    }
    return winner
  } finally {
    await rm(staging, { force: true }).catch(() => undefined)
  }
}
