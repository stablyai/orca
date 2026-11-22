/** A random id for this Orca installation, kept in its userData folder, that paired hosts use to
 *  tell desktops sharing one paired row apart (a path hash would match teammates' same paths). */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FILE_NAME = 'paired-desktop-instance-id'
const VALID_ID = /^[A-Za-z0-9_-]{16,128}$/

let cached: { userData: string; id: Promise<string> } | null = null

export function pairedDesktopInstanceId(userData: string): Promise<string> {
  if (cached?.userData !== userData) {
    cached = { userData, id: loadOrCreate(join(userData, FILE_NAME)) }
  }
  return cached.id
}

async function loadOrCreate(path: string): Promise<string> {
  const stored = await readStoredId(path)
  if (stored) {
    return stored
  }
  const id = randomBytes(18).toString('base64url')
  try {
    await writeFile(path, id, { flag: 'wx' })
    return id
  } catch {
    // Another process wrote first (keep its id), or the folder is read-only (this run only).
    return (await readStoredId(path)) ?? id
  }
}

async function readStoredId(path: string): Promise<string | null> {
  try {
    const stored = (await readFile(path, 'utf8')).trim()
    return VALID_ID.test(stored) ? stored : null
  } catch {
    return null
  }
}
