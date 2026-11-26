import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Writes an extension Orca loads into Pi once per content change and returns its path. */
export async function writePiExtensionFile(
  directory: string,
  file: string,
  source: string
): Promise<string> {
  const path = join(directory, file)
  if ((await readFile(path, 'utf8').catch(() => null)) === source) {
    return path
  }
  // Pi exits when an extension fails to load, so a concurrent launch must never read a partial file.
  await mkdir(directory, { recursive: true })
  const staged = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(staged, source)
    await rename(staged, path)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => {})
    throw error
  }
  return path
}
