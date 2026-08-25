import { constants, type Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  WORKSPACE_FILE_MAX_BYTES,
  canonicalWorkspaceDirectory,
  inspectWorkspaceRegular,
  inspectWorkspaceRegularIfPresent,
  readWorkspaceRegularBytes,
  resolveWorkspaceFileTarget,
  resolveWorkspacePath,
  type WorkspaceEdit,
  type WorkspaceFileSnapshot
} from './workspace-security-runtime.js'

const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const mutationTails = new Map<string, Promise<void>>()

function unsafe(reason: string): Error {
  return new Error(`Workspace path rejected: ${reason}`)
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

function sameIdentity(left: WorkspaceFileSnapshot, right: WorkspaceFileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function assertRegular(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw unsafe('target is not a single-link regular file')
  }
}

async function withMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve()
  let release = (): void => undefined
  const tail = new Promise<void>((resolveTail) => {
    release = resolveTail
  })
  mutationTails.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (mutationTails.get(key) === tail) {
      mutationTails.delete(key)
    }
  }
}

async function safeUnlinkTemp(path: string, owned?: WorkspaceFileSnapshot): Promise<void> {
  if (!owned) {
    return
  }
  try {
    const info = await lstat(path)
    assertRegular(info)
    if (sameSnapshot(owned, snapshot(info))) {
      await unlink(path)
    }
  } catch {
    // Never broaden cleanup after a failed identity check.
  }
}

async function replaceFile(
  root: string,
  inputPath: string,
  bytes: Buffer,
  expected?: { bytes: Buffer; snapshot: WorkspaceFileSnapshot }
): Promise<void> {
  if (bytes.byteLength > WORKSPACE_FILE_MAX_BYTES) {
    throw unsafe('content exceeds the byte limit')
  }
  const target = await resolveWorkspaceFileTarget(root, inputPath)
  await inspectWorkspaceRegularIfPresent(root, target)
  if (expected) {
    const current = await readWorkspaceRegularBytes(root, inputPath)
    if (
      !sameSnapshot(expected.snapshot, current.snapshot) ||
      !expected.bytes.equals(current.bytes)
    ) {
      throw unsafe('file changed before the edit could be committed')
    }
  }
  const parent = dirname(target)
  const temp = join(parent, `.orca-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let owned: WorkspaceFileSnapshot | undefined
  let renamed = false
  try {
    handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    )
    owned = snapshot(await handle.stat())
    assertRegular(await handle.stat())
    await handle.writeFile(bytes)
    await handle.sync()
    const written = await handle.stat()
    assertRegular(written)
    owned = snapshot(written)
    if (written.size !== bytes.byteLength) {
      throw unsafe('temporary write was incomplete')
    }
    await handle.close()
    handle = undefined
    if ((await canonicalWorkspaceDirectory(root, parent)) !== parent) {
      throw unsafe('parent path changed')
    }
    const tempInfo = await lstat(temp)
    assertRegular(tempInfo)
    if (!sameSnapshot(owned, snapshot(tempInfo))) {
      throw unsafe('temporary file changed')
    }
    if (expected) {
      const current = await readWorkspaceRegularBytes(root, inputPath)
      if (
        !sameSnapshot(expected.snapshot, current.snapshot) ||
        !expected.bytes.equals(current.bytes)
      ) {
        throw unsafe('file changed before atomic replacement')
      }
    } else {
      await inspectWorkspaceRegularIfPresent(root, target)
    }
    await rename(temp, target)
    renamed = true
    const committed = await inspectWorkspaceRegular(root, target)
    if (!sameIdentity(owned, committed)) {
      throw unsafe('committed file identity changed')
    }
  } finally {
    await handle?.close().catch(() => undefined)
    if (!renamed) {
      await safeUnlinkTemp(temp, owned)
    }
  }
}

export async function writeWorkspaceText(
  root: string,
  inputPath: string,
  content: string
): Promise<void> {
  const key = resolveWorkspacePath(root, inputPath)
  await withMutation(key, () => replaceFile(root, inputPath, Buffer.from(content, 'utf8')))
}

export function applyExactWorkspaceEdits(content: string, edits: WorkspaceEdit[]): string {
  if (edits.length < 1 || edits.length > 64) {
    throw unsafe('edit item count is invalid')
  }
  const located = edits.map((edit) => {
    if (edit.oldText.length < 1) {
      throw unsafe('edit oldText must not be empty')
    }
    const index = content.indexOf(edit.oldText)
    if (index === -1 || index !== content.lastIndexOf(edit.oldText)) {
      throw unsafe('each edit oldText must match exactly once')
    }
    return { ...edit, index, end: index + edit.oldText.length }
  })
  located.sort((left, right) => left.index - right.index)
  for (let index = 1; index < located.length; index += 1) {
    if (located[index]!.index < located[index - 1]!.end) {
      throw unsafe('edit ranges overlap')
    }
  }
  let next = content
  for (const edit of located.toReversed()) {
    next = `${next.slice(0, edit.index)}${edit.newText}${next.slice(edit.end)}`
  }
  if (Buffer.byteLength(next, 'utf8') > WORKSPACE_FILE_MAX_BYTES) {
    throw unsafe('edited content exceeds the byte limit')
  }
  return next
}

export async function editWorkspaceText(
  root: string,
  inputPath: string,
  edits: WorkspaceEdit[]
): Promise<void> {
  const key = resolveWorkspacePath(root, inputPath)
  await withMutation(key, async () => {
    const current = await readWorkspaceRegularBytes(root, inputPath)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes)
    } catch {
      throw unsafe('file is not valid UTF-8 text')
    }
    const next = applyExactWorkspaceEdits(text, edits)
    await replaceFile(root, inputPath, Buffer.from(next, 'utf8'), current)
  })
}
