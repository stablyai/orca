import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { normalizeCodexFileChangeKind } from './codex-structured-change-metadata'

export type CodexStructuredFileChange = { path: string; diff: string; kind: unknown }

export type CodexStructuredFileManifestEntry = {
  path: string
  exists: boolean
  sha256: string | null
  bytes: number | null
}

export type CodexStructuredWorktreeSnapshot = {
  root: string
  identity: string
}

const MAX_FILE_CHANGE_COUNT = 128
const MAX_FILE_CHANGE_PATH_BYTES = 4_096
const MAX_CHANGE_PLAN_DIFF_BYTES = 1024 * 1024
const MAX_CHANGE_PLAN_ENCODED_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_FILE_BYTES = 16 * 1024 * 1024
const MAX_MANIFEST_TOTAL_BYTES = 32 * 1024 * 1024

export async function validateLinkedWorktreeRoot(input: string): Promise<string> {
  return (await snapshotLinkedWorktreeRoot(input)).root
}

export async function snapshotLinkedWorktreeRoot(
  input: string
): Promise<CodexStructuredWorktreeSnapshot> {
  const root = await realpath(input)
  const rootMetadata = await stat(root)
  if (!rootMetadata.isDirectory()) {
    throw new Error('writable worktree root is not a directory')
  }
  const dotGit = resolve(root, '.git')
  const markerMetadata = await lstat(dotGit)
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
    throw new Error('structured writer requires a linked Git worktree, not a canonical clone')
  }
  const line = (await readFile(dotGit, 'utf8')).trim()
  if (!line.startsWith('gitdir:')) {
    throw new Error('linked worktree .git marker is invalid')
  }
  const gitDir = await realpath(resolve(root, line.slice('gitdir:'.length).trim()))
  const gitDirMetadata = await stat(gitDir)
  if (!gitDirMetadata.isDirectory()) {
    throw new Error('linked worktree Git directory is unavailable')
  }
  if (basename(dirname(gitDir)) !== 'worktrees') {
    throw new Error('linked worktree Git directory is outside the common worktree registry')
  }
  const backlink = (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim()
  if (!backlink) {
    throw new Error('linked worktree Git directory has no reciprocal backlink')
  }
  const resolvedBacklink = await realpath(resolve(gitDir, backlink))
  if (resolvedBacklink !== (await realpath(dotGit))) {
    throw new Error('linked worktree Git backlink does not name the selected worktree')
  }
  return {
    root,
    identity: [
      rootMetadata.dev,
      rootMetadata.ino,
      markerMetadata.dev,
      markerMetadata.ino,
      gitDirMetadata.dev,
      gitDirMetadata.ino,
      gitDir
    ].join(':')
  }
}

export async function snapshotChanges(
  root: string,
  changes: readonly CodexStructuredFileChange[]
): Promise<CodexStructuredFileManifestEntry[]> {
  const canonicalRoot = await realpath(root)
  const entries: CodexStructuredFileManifestEntry[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  for (const change of changes) {
    const absolute = await validateChangePath(canonicalRoot, change.path)
    const path = relative(canonicalRoot, absolute)
    if (seen.has(path)) {
      continue
    }
    seen.add(path)
    try {
      const bytes = await readBoundedRegularFile(
        absolute,
        path,
        MAX_MANIFEST_TOTAL_BYTES - totalBytes
      )
      totalBytes += bytes.byteLength
      entries.push({ path, exists: true, sha256: sha256(bytes), bytes: bytes.byteLength })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      entries.push({ path, exists: false, sha256: null, bytes: null })
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

export function parseFileChanges(value: unknown): CodexStructuredFileChange[] | null {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILE_CHANGE_COUNT) {
      return null
    }
    const changes: CodexStructuredFileChange[] = []
    let diffBytes = 0
    let encodedBytes = 2
    for (const entry of value) {
      const record = readChangeRecord(entry)
      if (!record) {
        return null
      }
      const path = record.path
      const diff = record.diff
      if (
        typeof path !== 'string' ||
        path.length === 0 ||
        path.includes('\0') ||
        Buffer.byteLength(path) > MAX_FILE_CHANGE_PATH_BYTES ||
        typeof diff !== 'string'
      ) {
        return null
      }
      const normalizedKind = normalizeCodexFileChangeKind(record.kind)
      if (!normalizedKind) {
        return null
      }
      const diffByteLength = Buffer.byteLength(diff)
      diffBytes += diffByteLength
      encodedBytes +=
        Buffer.byteLength(JSON.stringify(path)) +
        Buffer.byteLength(JSON.stringify(diff)) +
        normalizedKind.encodedBytes +
        32
      if (diffBytes > MAX_CHANGE_PLAN_DIFF_BYTES || encodedBytes > MAX_CHANGE_PLAN_ENCODED_BYTES) {
        return null
      }
      changes.push({ path, diff, kind: normalizedKind.value })
    }
    return changes
  } catch {
    return null
  }
}

function readChangeRecord(value: unknown): { path: unknown; diff: unknown; kind: unknown } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return null
  }
  const record: Record<string, unknown> = {}
  for (const key of ['path', 'diff', 'kind']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      return null
    }
    record[key] = descriptor.value
  }
  return { path: record.path, diff: record.diff, kind: record.kind }
}

async function readBoundedRegularFile(
  absolute: string,
  path: string,
  remainingBytes: number
): Promise<Buffer> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new Error(`structured writer target is not a regular file: ${path}`)
    }
    if (metadata.nlink !== 1) {
      throw new Error(`structured writer target has multiple hard links: ${path}`)
    }
    if (metadata.size > MAX_MANIFEST_FILE_BYTES) {
      throw new Error(`structured writer target is too large to manifest: ${path}`)
    }
    if (metadata.size > remainingBytes) {
      throw new Error('structured writer manifest exceeds its aggregate byte limit')
    }
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
    }
    const after = await handle.stat()
    const currentPath = await lstat(absolute)
    const currentCanonicalPath = await realpath(absolute)
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.nlink !== 1 ||
      after.size !== offset ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs ||
      !currentPath.isFile() ||
      currentPath.isSymbolicLink() ||
      currentPath.dev !== after.dev ||
      currentPath.ino !== after.ino ||
      currentPath.nlink !== 1 ||
      currentCanonicalPath !== absolute
    ) {
      throw new Error(`structured writer target changed while being manifested: ${path}`)
    }
    return offset === bytes.byteLength ? bytes : bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

async function validateChangePath(root: string, input: string): Promise<string> {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input)
  let ancestor = absolute
  while (true) {
    try {
      const metadata = await lstat(ancestor)
      if (metadata.isSymbolicLink()) {
        throw new Error(`structured writer target crosses a symbolic link: ${input}`)
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      const parent = dirname(ancestor)
      if (parent === ancestor) {
        throw error
      }
      ancestor = parent
    }
  }
  const canonicalAncestor = await realpath(ancestor)
  const canonicalTarget = resolve(canonicalAncestor, relative(ancestor, absolute))
  const targetRelative = relative(root, canonicalTarget)
  if (
    !targetRelative ||
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error(`structured writer target resolves outside its worktree: ${input}`)
  }
  if (targetRelative.split(sep).includes('.git')) {
    throw new Error('structured writer cannot mutate Git metadata')
  }
  return canonicalTarget
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
