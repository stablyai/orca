import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

const ROOT_NAME = 'chat-temporary'
const MARKER_NAME = '.orca-temporary-storage.json'
const ENTRY_NAME = /^[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_ENTRIES = 250_000

type Owner = { format: 1; folder: string; pid: number; createdAt: number }
export type ChatTemporaryEntry = {
  path: string
  reason:
    | 'eligible'
    | 'active-owner'
    | 'recent'
    | 'git-data'
    | 'scan-limit'
    | 'unmanaged'
    | 'unreadable'
  /** Unique allocated blocks within this entry, not a promise of reclaimable space. */
  allocatedBytes: number
  dev: number
  ino: number
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function chatTemporaryRoot(stateDirectory: string): string {
  return join(stateDirectory, ROOT_NAME)
}

export async function prepareChatTemporaryFolder(
  stateDirectory: string,
  sessionKey: string
): Promise<string> {
  if (!/^[0-9a-f]{32}$/.test(sessionKey)) {
    throw new Error('Invalid temporary storage session key')
  }
  const root = chatTemporaryRoot(stateDirectory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (!(await lstat(root)).isDirectory()) {
    throw new Error('Temporary storage root must be a directory, not a symlink')
  }
  const name = `${sessionKey}-${randomUUID()}`
  const path = join(root, name)
  await mkdir(path, { mode: 0o700 })
  const owner: Owner = { format: 1, folder: name, pid: process.pid, createdAt: Date.now() }
  await writeFile(join(path, MARKER_NAME), JSON.stringify(owner), { mode: 0o600, flag: 'wx' })
  const files = join(path, 'files')
  await mkdir(files, { mode: 0o700 })
  return files
}

function ownerIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function readOwner(path: string, folder: string): Promise<Owner | null> {
  const marker = join(path, MARKER_NAME)
  const info = await lstat(marker)
  if (!info.isFile() || info.size > 1024) {
    return null
  }
  const owner: unknown = JSON.parse(await readFile(marker, 'utf8'))
  if (
    typeof owner !== 'object' ||
    owner === null ||
    !('format' in owner) ||
    owner.format !== 1 ||
    !('folder' in owner) ||
    owner.folder !== folder ||
    !('pid' in owner) ||
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !('createdAt' in owner) ||
    typeof owner.createdAt !== 'number' ||
    !Number.isFinite(owner.createdAt) ||
    owner.createdAt <= 0
  ) {
    return null
  }
  return { format: 1, folder, pid: owner.pid, createdAt: owner.createdAt }
}

async function inspectTree(
  path: string,
  cutoff: number
): Promise<{
  reason: ChatTemporaryEntry['reason']
  allocatedBytes: number
}> {
  const inodes = new Set<string>()
  let allocatedBytes = 0
  let visited = 0
  async function visit(current: string, depth: number): Promise<ChatTemporaryEntry['reason']> {
    if (++visited > MAX_ENTRIES || depth > 64) {
      return 'scan-limit'
    }
    if (visited % 128 === 0) {
      await setImmediate()
    }
    const info = await lstat(current)
    const inode = `${info.dev}:${info.ino}`
    // Some filesystems expose no inode; count those paths independently.
    if (info.ino === 0 || !inodes.has(inode)) {
      inodes.add(inode)
      allocatedBytes += typeof info.blocks === 'number' ? info.blocks * 512 : info.size
    }
    if (info.mtimeMs > cutoff || info.ctimeMs > cutoff) {
      return 'recent'
    }
    if (!info.isDirectory()) {
      return 'eligible'
    }
    const bareNames = new Set<string>()
    for await (const entry of await opendir(current)) {
      if (entry.name === '.git') {
        return 'git-data'
      }
      if (entry.name === 'HEAD' || entry.name === 'objects' || entry.name === 'config') {
        bareNames.add(entry.name)
        if (bareNames.size === 3) {
          return 'git-data'
        }
      }
      const reason = await visit(join(current, entry.name), depth + 1)
      if (reason !== 'eligible') {
        return reason
      }
    }
    return 'eligible'
  }
  return { reason: await visit(path, 0), allocatedBytes }
}

type InspectionOptions = { now?: number; isOwnerRunning?: (pid: number) => boolean }

async function inspectEntry(
  root: string,
  name: string,
  { now = Date.now(), isOwnerRunning = ownerIsRunning }: InspectionOptions
): Promise<ChatTemporaryEntry> {
  const path = join(root, name)
  const row: ChatTemporaryEntry = {
    path,
    reason: 'unmanaged',
    allocatedBytes: 0,
    dev: 0,
    ino: 0
  }
  try {
    const info = await lstat(path)
    if (!info.isDirectory()) {
      return row
    }
    row.dev = info.dev
    row.ino = info.ino
    const owner = await readOwner(path, name)
    if (!owner) {
      return row
    }
    if (isOwnerRunning(owner.pid)) {
      row.reason = 'active-owner'
      return row
    }
    if (owner.createdAt > now - RETENTION_MS) {
      row.reason = 'recent'
      return row
    }
    Object.assign(row, await inspectTree(path, now - RETENTION_MS))
  } catch (error) {
    row.reason = missing(error) ? 'unmanaged' : 'unreadable'
  }
  return row
}

export async function inspectChatTemporaryStorage(
  stateDirectory: string,
  options: InspectionOptions = {},
  isStopped: () => boolean = () => false
): Promise<ChatTemporaryEntry[]> {
  const root = chatTemporaryRoot(stateDirectory)
  let entries
  try {
    if (!(await lstat(root)).isDirectory()) {
      return []
    }
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (missing(error)) {
      return []
    }
    throw error
  }
  const result: ChatTemporaryEntry[] = []
  for (const entry of entries) {
    if (isStopped()) {
      break
    }
    if (entry.isDirectory() && ENTRY_NAME.test(entry.name)) {
      result.push(await inspectEntry(root, entry.name, options))
    }
  }
  return result
}

export async function sweepChatTemporaryStorage(
  stateDirectory: string,
  options: InspectionOptions = {},
  isStopped: () => boolean = () => false
): Promise<{ removed: number; failed: number }> {
  const root = chatTemporaryRoot(stateDirectory)
  const result = { removed: 0, failed: 0 }
  let rootInfo
  try {
    rootInfo = await lstat(root)
  } catch (error) {
    if (missing(error)) {
      return result
    }
    throw error
  }
  if (!rootInfo.isDirectory()) {
    return result
  }
  const preview = await inspectChatTemporaryStorage(stateDirectory, options, isStopped)
  for (const entry of preview) {
    if (isStopped() || result.removed + result.failed >= 20) {
      break
    }
    if (entry.reason !== 'eligible') {
      continue
    }
    try {
      const name = entry.path.slice(root.length + 1)
      const beforeScan = await lstat(root)
      if (
        !beforeScan.isDirectory() ||
        beforeScan.dev !== rootInfo.dev ||
        beforeScan.ino !== rootInfo.ino
      ) {
        continue
      }
      const current = await inspectEntry(root, name, options)
      const currentRoot = await lstat(root)
      if (
        isStopped() ||
        !currentRoot.isDirectory() ||
        currentRoot.dev !== rootInfo.dev ||
        currentRoot.ino !== rootInfo.ino ||
        current.reason !== 'eligible' ||
        current.dev !== entry.dev ||
        current.ino !== entry.ino
      ) {
        continue
      }
      await rm(entry.path, { recursive: true })
      result.removed += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}
