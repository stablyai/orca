import type { Dirent } from 'node:fs'

export function dshGenerationVersion(path: string): number | null {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(name)
  if (!match) {
    return null
  }
  const version = Number(match[1] ?? 0)
  return Number.isSafeInteger(version) ? version : null
}

// Mixed encodings are ambiguous upstream too; never resume an arbitrary copy.
export function selectDshGenerationPaths(
  paths: readonly string[],
  reportInvalid?: (path: string, message: string) => void
): string[] {
  const directories = new Map<
    string,
    { version: number; path: string; ambiguous: boolean; compressed: boolean }
  >()
  for (const path of paths) {
    const version = dshGenerationVersion(path)
    if (version === null) {
      continue
    }
    const dir = path.replace(/[\\/][^\\/]+$/, '')
    const compressed = path.endsWith('.zstd')
    const previous = directories.get(dir)
    if (previous && previous.compressed !== compressed) {
      previous.ambiguous = true
    }
    if (!previous || version > previous.version) {
      directories.set(dir, { version, path, ambiguous: previous?.ambiguous ?? false, compressed })
    } else if (version === previous.version && previous.path !== path) {
      previous.ambiguous = true
    }
  }
  for (const [directory, entry] of directories) {
    if (entry.ambiguous) {
      reportInvalid?.(
        directory,
        'DSH history has conflicting compressed/uncompressed generations; refusing an arbitrary source'
      )
    }
  }
  return [...directories.values()].filter((entry) => !entry.ambiguous).map((entry) => entry.path)
}

export function selectDshGenerationEntries(
  entries: Dirent[],
  reportInvalid?: (message: string) => void
): Dirent[] {
  const selected = new Set(
    selectDshGenerationPaths(
      entries.filter((entry) => entry.isFile()).map((entry) => `/${entry.name}`),
      (_path, message) => reportInvalid?.(message)
    ).map((path) => path.slice(1))
  )
  return entries.filter((entry) => entry.isDirectory() || selected.has(entry.name))
}
