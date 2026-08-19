import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'

// Security boundary: untrusted model/repository input is confined to the exact
// sequential tools in the generated extension. Those tools cannot create,
// rename, or link directories. An already-compromised same-UID external process
// is outside this boundary because it can read Orca runtime metadata directly.
export const WORKSPACE_FILE_MAX_BYTES = 1024 * 1024
export const WORKSPACE_LIST_MAX_ITEMS = 256
export const WORKSPACE_PATH_MAX_CHARS = 1024

export type WorkspaceFileSnapshot = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

export type WorkspaceEdit = { oldText: string; newText: string }
export type WorkspaceListEntry = { name: string; kind: 'file' | 'directory' | 'blocked' }

type OpenedFile = {
  handle: Awaited<ReturnType<typeof open>>
  path: string
  snapshot: WorkspaceFileSnapshot
}

const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

function unsafe(reason: string): Error {
  return new Error(`Workspace path rejected: ${reason}`)
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

function snapshot(stat: Stats): WorkspaceFileSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  }
}

function sameSnapshot(left: WorkspaceFileSnapshot, right: WorkspaceFileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function assertRegular(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw unsafe('target is not a single-link regular file')
  }
}

export function resolveWorkspacePath(root: string, inputPath: string): string {
  if (
    inputPath.length < 1 ||
    inputPath.length > WORKSPACE_PATH_MAX_CHARS ||
    inputPath.includes('\0') ||
    isAbsolute(inputPath) ||
    win32.isAbsolute(inputPath) ||
    /^[a-zA-Z]:/u.test(inputPath)
  ) {
    throw unsafe('path must be a bounded relative path')
  }
  const candidate = resolve(root, inputPath)
  if (!isWithin(root, candidate)) {
    throw unsafe('path leaves the workspace')
  }
  return candidate
}

export async function canonicalWorkspaceRoot(cwd: string): Promise<string> {
  const root = await realpath(cwd)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw unsafe('workspace root is not a regular directory')
  }
  return root
}

export async function canonicalWorkspaceDirectory(
  root: string,
  candidate: string
): Promise<string> {
  if (!isWithin(root, candidate)) {
    throw unsafe('directory leaves the workspace')
  }
  let current = root
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw unsafe('workspace root changed')
  }
  const suffix = relative(root, candidate)
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw unsafe('directory path contains a link or non-directory')
    }
  }
  const canonical = await realpath(current)
  if (!isWithin(root, canonical)) {
    throw unsafe('canonical directory leaves the workspace')
  }
  return canonical
}

export async function resolveWorkspaceFileTarget(root: string, inputPath: string): Promise<string> {
  const candidate = resolveWorkspacePath(root, inputPath)
  const parent = await canonicalWorkspaceDirectory(root, dirname(candidate))
  return join(parent, basename(candidate))
}

export async function inspectWorkspaceRegular(
  root: string,
  target: string
): Promise<WorkspaceFileSnapshot> {
  const before = await lstat(target)
  assertRegular(before)
  const canonical = await realpath(target)
  if (!isWithin(root, canonical)) {
    throw unsafe('canonical file leaves the workspace')
  }
  const after = await lstat(canonical)
  assertRegular(after)
  const beforeSnapshot = snapshot(before)
  const afterSnapshot = snapshot(after)
  if (!sameSnapshot(beforeSnapshot, afterSnapshot)) {
    throw unsafe('file identity changed during validation')
  }
  return afterSnapshot
}

export async function inspectWorkspaceRegularIfPresent(
  root: string,
  target: string
): Promise<WorkspaceFileSnapshot | undefined> {
  try {
    return await inspectWorkspaceRegular(root, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function openRegular(root: string, inputPath: string): Promise<OpenedFile> {
  const target = await resolveWorkspaceFileTarget(root, inputPath)
  const expected = await inspectWorkspaceRegular(root, target)
  const canonical = await realpath(target)
  const handle = await open(canonical, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    assertRegular(opened)
    const openedSnapshot = snapshot(opened)
    if (!sameSnapshot(expected, openedSnapshot)) {
      throw unsafe('opened file did not match the validated file')
    }
    return { handle, path: canonical, snapshot: openedSnapshot }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function readOpened(opened: OpenedFile): Promise<Buffer> {
  if (opened.snapshot.size > WORKSPACE_FILE_MAX_BYTES) {
    throw unsafe('file exceeds the byte limit')
  }
  const buffer = Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1)
  let length = 0
  while (length < buffer.length) {
    const result = await opened.handle.read(buffer, length, buffer.length - length, length)
    if (result.bytesRead === 0) {
      break
    }
    length += result.bytesRead
  }
  if (length > WORKSPACE_FILE_MAX_BYTES) {
    throw unsafe('file grew beyond the byte limit')
  }
  const after = await opened.handle.stat()
  assertRegular(after)
  if (!sameSnapshot(opened.snapshot, snapshot(after))) {
    throw unsafe('file changed while it was read')
  }
  return buffer.subarray(0, length)
}

export async function readWorkspaceRegularBytes(
  root: string,
  inputPath: string
): Promise<{ bytes: Buffer; path: string; snapshot: WorkspaceFileSnapshot }> {
  const opened = await openRegular(root, inputPath)
  try {
    const bytes = await readOpened(opened)
    const current = await inspectWorkspaceRegular(root, opened.path)
    if (!sameSnapshot(opened.snapshot, current)) {
      throw unsafe('file entry changed while it was read')
    }
    return { bytes, path: opened.path, snapshot: current }
  } finally {
    await opened.handle.close()
  }
}

export async function readWorkspaceText(root: string, inputPath: string): Promise<string> {
  const { bytes } = await readWorkspaceRegularBytes(root, inputPath)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw unsafe('file is not valid UTF-8 text')
  }
}

export async function listWorkspaceEntries(
  root: string,
  inputPath: string,
  maxItems: number
): Promise<{ entries: WorkspaceListEntry[]; truncated: boolean }> {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > WORKSPACE_LIST_MAX_ITEMS) {
    throw unsafe('directory item limit is invalid')
  }
  const candidate = resolveWorkspacePath(root, inputPath)
  const directory = await canonicalWorkspaceDirectory(root, candidate)
  const before = snapshot(await lstat(directory))
  const entries: WorkspaceListEntry[] = []
  const stream = await opendir(directory)
  for await (const entry of stream) {
    if (entries.length === maxItems) {
      const after = snapshot(await lstat(directory))
      if (!sameSnapshot(before, after)) {
        throw unsafe('directory changed while it was listed')
      }
      return { entries, truncated: true }
    }
    const info = await lstat(join(directory, entry.name))
    const kind = info.isDirectory()
      ? 'directory'
      : info.isFile() && !info.isSymbolicLink() && info.nlink === 1
        ? 'file'
        : 'blocked'
    entries.push({ name: entry.name, kind })
  }
  const after = snapshot(await lstat(directory))
  if (!sameSnapshot(before, after)) {
    throw unsafe('directory changed while it was listed')
  }
  return { entries, truncated: false }
}
