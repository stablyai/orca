import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// Skip .gitattributes -text binaries; SVG stays textual because CRLF changes hashed buildId. Test holds exemptions to attributes.
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

// Require LF-pinned checkout: CRLF changes source bytes, asset hashes and buildId across platforms.
export async function assertNoCarriageReturnsInSource(directory) {
  const offenders = []
  for (const file of await listSourceFiles(directory)) {
    if (BINARY_SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
      continue
    }
    // Postinstall-generated ignored source needs no git EOL pin.
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
