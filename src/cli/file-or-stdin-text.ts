import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { RuntimeClientError } from './runtime/types'

/** Reads a `<path|->` flag value: a file relative to the caller's cwd, or stdin for `-`. */
export async function readFileOrStdinText(
  path: string,
  cwd: string,
  label: string
): Promise<string> {
  if (path !== '-') {
    return await readFile(isAbsolute(path) ? path : join(cwd, path), 'utf8')
  }
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', `stdin ${label} requested but stdin is a TTY`)
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
