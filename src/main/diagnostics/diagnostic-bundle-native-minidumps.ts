import { readFile } from 'node:fs/promises'
import type {
  DiagnosticBundleCategory,
  DiagnosticBundleCategoryResult
} from '../../shared/diagnostic-bundle-export-types'
import { sanitizeDiagnosticCategoryError } from './diagnostic-bundle-json-category'
import { listNativeCrashDumps } from './native-crash-dump-index'

const MAX_NATIVE_MINIDUMPS = 10

type CategoryEntryAdder = (
  category: DiagnosticBundleCategory,
  path: string,
  content: Buffer | string
) => void
type CategoryResultRecorder = (result: DiagnosticBundleCategoryResult) => void

export async function collectNativeMinidumpCategory(
  record: CategoryResultRecorder,
  addEntry: CategoryEntryAdder,
  lookbackMinutes: number
): Promise<void> {
  const category = 'native-minidumps'
  try {
    const dumps = await listNativeCrashDumps(lookbackMinutes)
    if (dumps.length === 0) {
      record({ category, status: 'skipped', reason: 'none_found', files: [] })
      return
    }
    const selected = dumps.slice(0, MAX_NATIVE_MINIDUMPS)
    const files: string[] = []
    for (const [index, dump] of selected.entries()) {
      const path = `crash/minidumps/${String(index + 1).padStart(2, '0')}-${safeArchiveSegment(
        dump.name
      )}`
      addEntry(category, path, await readFile(dump.path))
      files.push(path)
    }
    record({
      category,
      status: dumps.length > selected.length ? 'truncated' : 'included',
      ...(dumps.length > selected.length ? { reason: 'minidump_count_cap' } : {}),
      files
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      record({ category, status: 'skipped', reason: 'missing_directory', files: [] })
      return
    }
    record({ category, status: 'error', reason: sanitizeDiagnosticCategoryError(error), files: [] })
  }
}

function safeArchiveSegment(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '')
  return sanitized.length > 0 ? sanitized : 'dump.dmp'
}
