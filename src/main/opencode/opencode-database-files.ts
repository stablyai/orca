import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

export const OPENCODE_DATABASE_FILE_LIMIT = 256

type OpenCodeDatabaseDirectoryEntry = {
  name: string
  isFile(): boolean
}

export type OpenCodeDatabaseFiles = {
  paths: string[]
  truncated: boolean
}

export async function listOpenCodeDatabaseFiles(dataDir: string): Promise<OpenCodeDatabaseFiles> {
  try {
    return collectOpenCodeDatabaseFiles(dataDir, await opendir(dataDir))
  } catch {
    return { paths: [], truncated: false }
  }
}

export async function collectOpenCodeDatabaseFiles(
  dataDir: string,
  directory: AsyncIterable<OpenCodeDatabaseDirectoryEntry>,
  maxFiles = OPENCODE_DATABASE_FILE_LIMIT
): Promise<OpenCodeDatabaseFiles> {
  const paths: string[] = []
  for await (const entry of directory) {
    if (!entry.isFile() || !/^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name)) {
      continue
    }
    if (paths.length >= maxFiles) {
      return { paths: paths.sort(), truncated: true }
    }
    paths.push(join(dataDir, entry.name))
  }
  return { paths: paths.sort(), truncated: false }
}
