import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getNativeCrashDumpDirectory } from './native-crash-dump-directory'

export type NativeCrashDumpFile = {
  path: string
  name: string
  bytes: number
  modifiedAt: string
}

const MINIDUMP_EXTENSIONS = new Set(['.dmp', '.mdmp'])

export async function listNativeCrashDumps(
  lookbackMinutes: number
): Promise<NativeCrashDumpFile[]> {
  const directory = getNativeCrashDumpDirectory()
  const cutoffMs = Date.now() - lookbackMinutes * 60 * 1000
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files: NativeCrashDumpFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const name = entry.name
    const dot = name.lastIndexOf('.')
    const extension = dot >= 0 ? name.slice(dot).toLowerCase() : ''
    if (!MINIDUMP_EXTENSIONS.has(extension)) {
      continue
    }
    const fullPath = join(entry.parentPath ?? directory, name)
    const info = await stat(fullPath)
    if (info.mtimeMs < cutoffMs) {
      continue
    }
    files.push({
      path: fullPath,
      name: basename(fullPath),
      bytes: info.size,
      modifiedAt: info.mtime.toISOString()
    })
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}
