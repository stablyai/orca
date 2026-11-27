import { randomBytes } from 'node:crypto'
import { linkSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import {
  bestEffortFsyncDirectorySync,
  writeSecureFile
} from '../../shared/secure-storage/secure-file'
import { readPrivateWindowsFile } from '../../shared/secure-storage/secure-path-windows-acl'

const SECRET_FILE = 'mcp-server-set-key.secret'
const SECRET_HEX = /^[0-9a-f]{64}$/

let secret: Promise<Buffer> | null = null

/**
 * This install's key for `mcpServerSetKey`: 32 random bytes in userData, published whole and
 * restricted to this user (an owner-only ACL on Windows), and reused only while it still is. One
 * that can't be read privately, or stored where only this user can read it, stays in memory for
 * this run alone: a kept agent's next launch then reads as changed and gets a fresh agent, which
 * is safe.
 */
export function mcpServerSetKeySecret(): Promise<Buffer> {
  secret ??= loadSecret().catch(() => randomBytes(32))
  return secret
}

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

/** The kept secret, or null when there is none; throws when it isn't private or well formed. */
async function readPrivate(path: string): Promise<Buffer | null> {
  let text: string
  if (process.platform === 'win32') {
    // The ACL is checked on the same handle the bytes are read through.
    const bytes = readPrivateWindowsFile(path, 128)
    if (!bytes) {
      return null
    }
    text = bytes.toString('utf8')
  } else {
    try {
      const info = await stat(path)
      if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
        throw new Error('MCP server set key secret is readable by others')
      }
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        return null
      }
      throw error
    }
  }
  const kept = text.trim()
  if (!SECRET_HEX.test(kept)) {
    throw new Error('MCP server set key secret is malformed')
  }
  return Buffer.from(kept, 'hex')
}

async function loadSecret(): Promise<Buffer> {
  const path = join(getCanonicalUserDataPath(), SECRET_FILE)
  const kept = await readPrivate(path)
  if (kept) {
    return kept
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
      if (!hasCode(error, 'EEXIST')) {
        throw error
      }
      // Another process published first: its secret is the install's.
      const winner = await readPrivate(path)
      if (!winner) {
        throw error
      }
      return winner
    }
  } finally {
    // Once published, a failed cleanup or sync never replaces the key this run uses.
    try {
      rmSync(staging, { force: true })
    } catch {}
  }
  try {
    bestEffortFsyncDirectorySync(dirname(path))
  } catch {}
  return fresh
}
