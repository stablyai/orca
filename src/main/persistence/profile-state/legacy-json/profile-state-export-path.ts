import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Return the immutable JSON artifact created when a profile first enters SQLite authority. */
export function profileStateJsonExportPath(dataFile: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Profile state export revision must be a positive safe integer')
  }
  return `${dataFile}.sqlite-export.${revision}.json`
}

/** List retained rollback exports newest-first without opening SQLite. */
export function profileStateJsonExportPaths(dataFile: string): readonly string[] {
  const directory = dirname(dataFile)
  const prefix = `${basename(dataFile)}.sqlite-export.`
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory)
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
