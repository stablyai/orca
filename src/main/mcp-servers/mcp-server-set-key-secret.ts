import { randomBytes } from 'node:crypto'
import { linkSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import {
  bestEffortFsyncDirectorySync,
  writeSecureFile
} from '../../../shared/secure-storage/secure-file'

const SECRET_FILE = 'mcp-server-set-key.secret'
const SECRET_HEX = /^[0-9a-f]{64}$/

let secret: Promise<Buffer> | null = null

/**
 * This install's key for `mcpServerSetKey`: 32 random bytes in userData, published whole and
 * restricted to this user (an owner-only ACL on Windows). One that can't be read, or stored where
 * only this user can read it, stays in memory for this run alone: a kept agent's next launch then
 * reads as changed and gets a fresh agent, which is safe.
 */
export function mcpServerSetKeySecret(): Promise<Buffer> {
  secret ??= loadSecret().catch(() => randomBytes(32))
  return secret
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

async function loadSecret(): Promise<Buffer> {
  const path = join(getCanonicalUserDataPath(), SECRET_FILE)
  const read = async (): Promise<Buffer> => {
    const kept = (await readFile(path, 'utf8')).trim()
    if (!SECRET_HEX.test(kept)) {
      throw new Error('MCP server set key secret is malformed')
    }
    return Buffer.from(kept, 'hex')
  }
  try {
    return await read()
  } catch (error) {
    if (!missing(error)) {
      throw error
    }
  }
  const fresh = randomBytes(32)
  const staging = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.staging`
  try {
    // Staged whole and restricted first, then linked in: no reader sees a partial or open file.
    if (!writeSecureFile(staging, fresh.toString('hex'), { durable: true, ownerOnly: true })) {
      return fresh
    }
    try {
      linkSync(staging, path)
    } catch (error) {
      // Another process published first: its secret is the install's.
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return read()
      }
      throw error
    }
    bestEffortFsyncDirectorySync(dirname(path))
    return fresh
  } finally {
    rmSync(staging, { force: true })
  }
}
