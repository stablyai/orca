import { t } from '@/i18n/mobile-i18n'
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/

export type SparsePresetDirectoryParseResult = {
  directories: string[]
  error: string | null
}

function isAbsoluteSparseDirectoryPath(value: string): boolean {
  const entry = value.trim()
  return entry.startsWith('/') || entry.startsWith('\\') || WINDOWS_DRIVE_PATH_PATTERN.test(entry)
}

function normalizeSparseDirectoryLines(value: string): string[] {
  const seen = new Set<string>()
  return value
    .split('\n')
    .map((entry) =>
      entry
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
    )
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      if (seen.has(entry)) {
        return false
      }
      seen.add(entry)
      return true
    })
}

export function parseSparsePresetDirectories(value: string): SparsePresetDirectoryParseResult {
  const rawEntries = value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  // Why: absolute paths can look repo-relative after slash normalization.
  if (rawEntries.some(isAbsoluteSparseDirectoryPath)) {
    return {
      directories: [],
      error: t('m.TgLMnDc')
    }
  }

  const directories = normalizeSparseDirectoryLines(value)

  if (directories.length === 0) {
    return {
      directories,
      error: t('m.M0WKvoE')
    }
  }

  if (directories.some((entry) => entry === '.' || entry.split('/').includes('..'))) {
    return {
      directories: [],
      error: t('m.TgLMnDc')
    }
  }

  return {
    directories,
    error: null
  }
}
