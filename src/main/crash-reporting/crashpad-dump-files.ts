// Filesystem access to Crashpad's dump database, shared by crash pairing and
// the previous-session check.

import { constants as fsConstants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { readCrashpadAnnotations } from './minidump-crashpad-annotations'
import { createMinidumpFileSource } from './minidump-file-source'
import { MinidumpView } from './minidump-stream-reader'

export type DumpCandidate = {
  readonly filePath: string
  readonly mtimeMs: number
  readonly size: number
}

export async function collectDumpCandidates(directory: string): Promise<DumpCandidate[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, {
      withFileTypes: true,
      recursive: true
    })
  } catch {
    return []
  }
  const candidates: DumpCandidate[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.dmp')) {
      continue
    }
    // `recursive` yields nested names relative to parentPath, not directory.
    const filePath = path.join(entry.parentPath ?? directory, entry.name)
    try {
      const stats = await stat(filePath)
      candidates.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size })
    } catch {
      // Crashpad renames dumps as it promotes them; a vanished file is normal.
    }
  }
  return candidates
}

// Why annotations only: they sit in a few metadata pages, so no captured memory is read.
export async function readDumpProcessType(filePath: string): Promise<string | null> {
  const opened = await openRegularDumpFile(filePath)
  if (!opened) {
    return null
  }
  try {
    const view = new MinidumpView(createMinidumpFileSource(opened.handle, opened.sizeBytes))
    return (await readCrashpadAnnotations(view)).ptype ?? null
  } catch {
    return null
  } finally {
    await opened.handle.close()
  }
}

export async function openRegularDumpFile(
  filePath: string
): Promise<{ handle: FileHandle; sizeBytes: number } | null> {
  // Reject symlink swaps where the platform exposes O_NOFOLLOW; the regular-file
  // check below covers descriptors opened on every platform.
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const handle = await open(filePath, noFollow === 0 ? 'r' : fsConstants.O_RDONLY | noFollow).catch(
    () => null
  )
  if (!handle) {
    return null
  }
  const stats = await handle.stat().catch(() => null)
  if (!stats?.isFile()) {
    await handle.close()
    return null
  }
  return { handle, sizeBytes: stats.size }
}
