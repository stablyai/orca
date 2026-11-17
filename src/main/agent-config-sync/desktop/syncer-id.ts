import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'

// One read per profile; concurrent first syncs share it, so they can't mint two ids.
const cache = new Map<string, Promise<string>>()

async function load(userDataPath: string): Promise<string> {
  const path = join(userDataPath, 'mcp-sync-syncer-id')
  try {
    const stored = (await readFile(path, 'utf8')).trim()
    if (/^[a-f0-9]{16}$/.test(stored)) {
      return stored
    }
  } catch {
    // First sync from this computer.
  }
  const id = randomBytes(8).toString('hex')
  try {
    writeFileAtomically(path, `${id}\n`)
  } catch {
    // Unwritable profile: this run still syncs as itself; the next launch gets a new id.
  }
  return id
}

/** This computer's stable sync identity (random, not a device fingerprint). The host keeps one
 * ledger per syncer, so two computers syncing one sandbox never remove each other's items. */
export function readOrCreateSyncerId(userDataPath: string): Promise<string> {
  let id = cache.get(userDataPath)
  if (!id) {
    id = load(userDataPath)
    cache.set(userDataPath, id)
  }
  return id
}
