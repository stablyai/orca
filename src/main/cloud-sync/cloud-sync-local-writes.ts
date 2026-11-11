// The disk half of a sync pass on this computer: copies are paged into a temp file, made
// read-only, then renamed into place; removals touch only files this computer copied. Nothing
// goes through a symlinked parent, so a planted link can't redirect a write or delete.
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import { transferRuntimeFile } from '../runtime-downloads/runtime-download-transfer'
import { CONTEXT_DIR, SYNC_TEMP_DIR, ensureSafeParent, hasSafeParents } from './cloud-sync-paths'
import {
  isLocalCopyEdited,
  type IndexEntry,
  type LocalStat,
  type RemoteEntry
} from './cloud-sync-plan'
import type { SyncCall } from './cloud-sync-remote'

const DOWNLOAD_CONCURRENCY = 6
/** files.readChunk's page size (transferRuntimeFile's default). */
const CHUNK_BYTES = 512 * 1024
const READ_ONLY_MODE = 0o444
const PAGE_TIMEOUT_MS = 60_000
const PageSchema = z.object({
  contentBase64: z.string(),
  bytesRead: z.number().int().nonnegative(),
  eof: z.boolean().optional()
})

export async function localStatAt(folder: string, relativePath: string): Promise<LocalStat> {
  if (!(await hasSafeParents(folder, relativePath))) {
    return null
  }
  const info = await lstat(join(folder, relativePath)).catch(() => null)
  return info && info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null
}

/**
 * Files and bytes the folder holds, and how many copies were changed here. A full pass checks
 * every copy (its stats are in `local`); an incremental pass only re-checks its own paths.
 */
export async function summarizeCopies(
  folder: string,
  entries: Record<string, IndexEntry>,
  pass: {
    local: ReadonlyMap<string, LocalStat>
    scoped: ReadonlySet<string> | null
    downloaded: ReadonlySet<string>
  }
): Promise<{ files: number; bytes: number; edited: number }> {
  let files = 0
  let bytes = 0
  let edited = 0
  for (const [path, entry] of Object.entries(entries)) {
    files++
    bytes += entry.ls
    if (pass.downloaded.has(path) || (pass.scoped && !pass.scoped.has(path))) {
      continue
    }
    const here = pass.scoped ? await localStatAt(folder, path) : (pass.local.get(path) ?? null)
    if (here && isLocalCopyEdited(entry, here)) {
      edited++
    }
  }
  return { files, bytes, edited }
}

/** Removes copies this computer made (per the index) and the directories they leave empty. */
export async function removeCopies(
  folder: string,
  paths: readonly string[],
  entries: Record<string, IndexEntry>
): Promise<void> {
  for (const path of paths) {
    // Only files this computer copied are ever removed, and only while they are still files.
    if (entries[path] && (await localStatAt(folder, path)) !== null) {
      await unlink(join(folder, path)).catch(() => undefined)
    }
    delete entries[path]
  }
  await pruneEmptyDirs(folder, paths)
}

/** Directories emptied by removals go too (never the folder itself or `.context`). */
export async function pruneEmptyDirs(folder: string, removed: readonly string[]): Promise<void> {
  const dirs = new Set<string>()
  for (const path of removed) {
    const parts = path.split('/')
    for (let i = parts.length - 1; i > 0; i--) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (dir !== CONTEXT_DIR && (await hasSafeParents(folder, `${dir}/x`))) {
      await rmdir(join(folder, dir)).catch(() => undefined)
    }
  }
}

export type DownloadInput = {
  call: SyncCall
  selector: string
  folder: string
  paths: readonly string[]
  remote: ReadonlyMap<string, RemoteEntry>
  entries: Record<string, IndexEntry>
  maxFileBytes: number
  signal: AbortSignal
  onProgress: (done: number, total: number) => void
  /** Saves the index now and then, so a long first copy resumes instead of restarting. */
  checkpoint: () => Promise<void>
  log: (line: string) => void
}

const INDEX_SAVE_EVERY = 200

/** One page for a file the manifest says is smaller than a page; false when it turned out bigger. */
async function readWhole(input: DownloadInput, path: string, sink: FileHandle): Promise<boolean> {
  const page = PageSchema.parse(
    await input.call(
      'files.readChunk',
      { worktree: input.selector, relativePath: path, offset: 0, length: CHUNK_BYTES },
      { timeoutMs: PAGE_TIMEOUT_MS, signal: input.signal }
    )
  )
  const bytes = Buffer.from(page.contentBase64, 'base64')
  if (bytes.byteLength !== page.bytesRead || (!page.eof && page.bytesRead >= CHUNK_BYTES)) {
    // Grew past one page since the manifest: page it properly.
    await sink.truncate(0)
    return false
  }
  await sink.write(bytes, 0, bytes.byteLength, 0)
  return true
}

async function copyOne(input: DownloadInput, path: string, entry: RemoteEntry): Promise<void> {
  const temp = join(input.folder, SYNC_TEMP_DIR, randomUUID())
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      // Most files fit one page and the manifest already has their size: one call, not stat + page.
      const done = entry.size < CHUNK_BYTES && (await readWhole(input, path, handle))
      if (!done) {
        await transferRuntimeFile({
          call: (method, params, options) => input.call(method, params, options),
          worktree: input.selector,
          relativePath: path,
          sink: handle,
          signal: input.signal,
          maxBytes: input.maxFileBytes,
          concurrency: 2,
          onProgress: () => undefined
        })
      }
    } finally {
      await handle.close()
    }
    await chmod(temp, READ_ONLY_MODE)
    const target = await ensureSafeParent(input.folder, path)
    const existing = await lstat(target).catch(() => null)
    if (existing && !existing.isFile()) {
      // A directory or link sits where the cloud has a file: never replace what we didn't write.
      throw new Error('path_conflict')
    }
    await rename(temp, target)
    const written = await lstat(target)
    input.entries[path] = { rs: entry.size, rm: entry.mtime, ls: written.size, lm: written.mtimeMs }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    if (!input.signal.aborted) {
      // One file that vanished or changed type mid-copy shouldn't fail the pass.
      input.log(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export async function downloadCopies(input: DownloadInput): Promise<void> {
  await mkdir(join(input.folder, SYNC_TEMP_DIR), { recursive: true })
  let done = 0
  let sinceSave = 0
  let next = 0
  const total = input.paths.length
  input.onProgress(done, total)
  const worker = async (): Promise<void> => {
    while (next < input.paths.length && !input.signal.aborted) {
      const path = input.paths[next++]!
      const entry = input.remote.get(path)
      if (entry) {
        await copyOne(input, path, entry)
      }
      done++
      if (++sinceSave >= INDEX_SAVE_EVERY) {
        sinceSave = 0
        await input.checkpoint().catch(() => undefined)
      }
      input.onProgress(done, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, total) }, worker))
  await rm(join(input.folder, SYNC_TEMP_DIR), { recursive: true, force: true }).catch(
    () => undefined
  )
}
