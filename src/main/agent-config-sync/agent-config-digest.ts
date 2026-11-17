import { createHash } from 'node:crypto'

export type AgentConfigDigestEntry = {
  /** Relative path inside a skill folder, or `.` for a command file. */
  path: string
  executable: boolean
  bytes: Buffer
}

/** Content identity of one item. Desktop and host compute it the same way, so either side can tell
 * whether a sandbox copy is exactly what this computer sent. */
export function agentConfigDigest(entries: readonly AgentConfigDigestEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )) {
    const body = createHash('sha256').update(entry.bytes).digest('hex')
    hash.update(`${entry.path}\0${entry.executable ? 1 : 0}\0${body}\n`)
  }
  return hash.digest('hex')
}
