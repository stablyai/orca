import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

const SECRET_FILE = 'mcp-server-set-key.secret'
const SECRET_BYTES = 32

let secret: Promise<Buffer> | null = null

/**
 * This install's key for `mcpServerSetKey`, made once in userData, owner-only. One that can't be
 * read or written gives a key for this run alone: a kept agent's next launch then reads as
 * changed and gets a fresh agent, which is safe.
 */
export function mcpServerSetKeySecret(): Promise<Buffer> {
  secret ??= loadSecret().catch(() => randomBytes(SECRET_BYTES))
  return secret
}

async function loadSecret(): Promise<Buffer> {
  const directory = getCanonicalUserDataPath()
  const path = join(directory, SECRET_FILE)
  const read = async (): Promise<Buffer> => {
    const kept = await readFile(path)
    if (kept.length !== SECRET_BYTES) {
      throw new Error('MCP server set key secret is malformed')
    }
    return kept
  }
  try {
    return await read()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  const fresh = randomBytes(SECRET_BYTES)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    // Created exclusively, so two app processes starting together keep one secret.
    await writeFile(path, fresh, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return read()
    }
    throw error
  }
  // The umask can strip mode bits but never add them; chmod sets exactly owner-only.
  await chmod(path, 0o600)
  return fresh
}
