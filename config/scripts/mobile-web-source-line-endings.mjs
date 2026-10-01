import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Pinned `-text` in .gitattributes and skipped below, because a 0x0d in them means nothing. .svg
 * is absent on purpose: it is text, so the eol=lf pin applies and a CRLF .svg forks the buildId.
 * A test keeps this list and the .gitattributes exemptions in step.
 */
export const BINARY_SOURCE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2'
]

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(entryPath)))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }
  return files.sort()
}

/**
 * A CRLF checkout changes the bytes of every text source, which changes every asset hash and so
 * the buildId. .gitattributes pins eol=lf; this is what notices when that pin stops working.
 */
export async function assertNoCarriageReturnsInSource(directory) {
  const offenders = []
  for (const file of await listSourceFiles(directory)) {
    if (BINARY_SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
      continue
    }
    // Written by mobile's postinstall, gitignored, so no eol pin applies and none is needed.
    if (file.endsWith('.generated.ts')) {
      continue
    }
    if ((await readFile(file)).includes(0x0d)) {
      offenders.push(file.slice(directory.length + 1))
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `CRLF in mobile web source, which would change every asset hash and the buildId: ` +
        `${offenders.join(', ')}. Check the .gitattributes eol=lf pin for ${directory}.`
    )
  }
}
