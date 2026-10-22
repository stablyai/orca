import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../durable-file-write'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

/**
 * One file per distro under `<userData>/wsl-distro-holders/`. Survives a full Orca quit on
 * purpose: the holder does too, and the next launch re-adopts it from this record.
 */
export type WslDistroHolderRecord = {
  version: 1
  distro: string
  pid: number
  /** Process creation time (Unix ms) from the process table; null when the table could not say. */
  creationTimeMs: number | null
  startedAtMs: number
}

const HOLDER_DIRECTORY = 'wsl-distro-holders'
const RECORD_SUFFIX = '.json'

export function wslDistroHolderKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export function wslDistroHolderDirectory(userDataPath: string): string {
  return join(userDataPath, HOLDER_DIRECTORY)
}

function recordPath(userDataPath: string, distro: string): string {
  return join(
    wslDistroHolderDirectory(userDataPath),
    `${encodeURIComponent(wslDistroHolderKey(distro))}${RECORD_SUFFIX}`
  )
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function parseWslDistroHolderRecord(text: string): WslDistroHolderRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const fields = new Map<string, unknown>(Object.entries(parsed))
  const version = fields.get('version')
  const distro = fields.get('distro')
  const pid = fields.get('pid')
  const creationTimeMs = fields.get('creationTimeMs')
  const startedAtMs = fields.get('startedAtMs')
  if (
    version !== 1 ||
    typeof distro !== 'string' ||
    wslDistroHolderKey(distro) === '' ||
    !isPositiveInteger(pid) ||
    !(creationTimeMs === null || isPositiveInteger(creationTimeMs)) ||
    !isPositiveInteger(startedAtMs)
  ) {
    return null
  }
  return { version, distro, pid, creationTimeMs, startedAtMs }
}

export type WslDistroHolderRecordRead =
  | { status: 'absent' }
  | { status: 'present'; record: WslDistroHolderRecord }
  /** Present but not ours to parse, or not readable: the holder it named cannot be identified. */
  | { status: 'corrupt' }
  | { status: 'unreadable' }

export async function readWslDistroHolderRecord(
  userDataPath: string,
  distro: string
): Promise<WslDistroHolderRecordRead> {
  let text: string
  try {
    text = await readFile(recordPath(userDataPath, distro), 'utf8')
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { status: 'absent' } : { status: 'unreadable' }
  }
  const record = parseWslDistroHolderRecord(text)
  if (!record || wslDistroHolderKey(record.distro) !== wslDistroHolderKey(distro)) {
    return { status: 'corrupt' }
  }
  return { status: 'present', record }
}

export async function writeWslDistroHolderRecord(
  userDataPath: string,
  record: WslDistroHolderRecord
): Promise<void> {
  const finalPath = recordPath(userDataPath, record.distro)
  await mkdir(dirname(finalPath), { recursive: true })
  await writeFileDurable(durableWriteTempPath(finalPath), finalPath, `${JSON.stringify(record)}\n`)
}

export async function removeWslDistroHolderRecord(
  userDataPath: string,
  distro: string
): Promise<void> {
  await rm(recordPath(userDataPath, distro), { force: true })
}

/**
 * Distro names that have a record file; sweeps temp files a crashed writer left behind.
 * Why decode the file name: the record may be corrupt, and its file is still owed a verdict.
 */
export async function listWslDistroHolderRecordDistros(userDataPath: string): Promise<string[]> {
  const directory = wslDistroHolderDirectory(userDataPath)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }
  const distros: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith(RECORD_SUFFIX)) {
      continue
    }
    const path = join(directory, entry)
    await removeStaleDurableWriteTempFiles(path, { minimumAgeMs: 60_000 }).catch(() => {})
    try {
      const distro = decodeURIComponent(entry.slice(0, -RECORD_SUFFIX.length))
      if (wslDistroHolderKey(distro) !== '') {
        distros.push(distro)
      }
    } catch {
      await rm(path, { force: true })
    }
  }
  return distros
}
