import { readdir } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Immutable artifact from the initial transition to SQLite authority. */
export function profileStateJsonExportPath(dataFile: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Profile state export revision must be a positive safe integer')
  }
  return `${dataFile}.sqlite-export.${revision}.json`
}

/** Newest-first rollback artifacts, available even if SQLite cannot open. */
export function profileStateJsonExportPaths(dataFile: string): readonly string[] {
  const directory = dirname(dataFile)
  if (!existsSync(directory)) {
    return []
  }
  return parseExportPaths(dataFile, readdirSync(directory))
}

export async function profileStateJsonExportPathsAsync(
  dataFile: string
): Promise<readonly string[]> {
  try {
    return parseExportPaths(dataFile, await readdir(dirname(dataFile)))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function parseExportPaths(dataFile: string, entries: string[]): readonly string[] {
  const directory = dirname(dataFile)
  const prefix = `${basename(dataFile)}.sqlite-export.`
  return entries
    .flatMap((name) => {
      const match = new RegExp(`^${escapeRegExp(prefix)}(\\d+)\\.json$`).exec(name)
      if (match === null) {
        return []
      }
      const revision = Number(match[1])
      return Number.isSafeInteger(revision) && revision > 0
        ? [{ path: join(directory, name), revision }]
        : []
    })
    .sort((left, right) => right.revision - left.revision)
    .map(({ path }) => path)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
