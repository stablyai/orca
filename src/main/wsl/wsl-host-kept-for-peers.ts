/**
 * R39: a Remove that kept a WSL host's server for another Orca leaves that server, and anything a
 * move put on it, running. Undo of such a move must not read the removed host as stopped.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

const KEPT_FILE = 'orca-wsl-hosts-kept-for-peers.json'
const MAX_KEPT_FILE_BYTES = 64 * 1024

const KeptListSchema = z.object({
  version: z.literal(1),
  environmentIds: z.array(z.string().min(1).max(256))
})

function keptFile(userDataPath: string): string {
  return join(userDataPath, KEPT_FILE)
}

function readKeptList(userDataPath: string): string[] {
  try {
    const { buffer } = readNodeFileSyncWithinLimit(keptFile(userDataPath), MAX_KEPT_FILE_BYTES)
    return KeptListSchema.parse(JSON.parse(buffer.toString('utf8'))).environmentIds
  } catch {
    return []
  }
}

/** Throws when it can't be saved, so the caller doesn't report a plain stop. */
export function recordWslHostKeptForPeers(userDataPath: string, environmentId: string): void {
  const current = readKeptList(userDataPath)
  if (current.includes(environmentId)) {
    return
  }
  writeSecureJsonFileWithinLimit(
    keptFile(userDataPath),
    { version: 1, environmentIds: [...current, environmentId] },
    MAX_KEPT_FILE_BYTES,
    { durable: true }
  )
}

export function wasWslHostKeptForPeers(userDataPath: string, environmentId: string): boolean {
  return readKeptList(userDataPath).includes(environmentId)
}

/** A later Remove proved the server stopped: nothing of the host runs on. */
export function forgetWslHostKeptForPeers(userDataPath: string, environmentId: string): void {
  const current = readKeptList(userDataPath)
  if (!current.includes(environmentId)) {
    return
  }
  writeSecureJsonFileWithinLimit(
    keptFile(userDataPath),
    { version: 1, environmentIds: current.filter((id) => id !== environmentId) },
    MAX_KEPT_FILE_BYTES,
    { durable: true }
  )
}
