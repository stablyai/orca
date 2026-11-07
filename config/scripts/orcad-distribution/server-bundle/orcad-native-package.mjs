import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { x as extractTar } from 'tar'
import { parseAllDocuments } from 'yaml'

const archiveLimit = 16 * 1024 * 1024

function parseLockfile(contents) {
  const packages = {}
  for (const document of parseAllDocuments(contents)) {
    if (document.errors.length) {
      throw document.errors[0]
    }
    Object.assign(packages, document.toJS()?.packages)
  }
  return { packages }
}

function verifyArchive(bytes, integrity) {
  if (bytes.length > archiveLimit) {
    throw new Error('Native package archive exceeds the size limit')
  }
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) {
    throw new Error('Native package archive does not match the lockfile integrity')
  }
}

/** Fetch a size-bounded, lockfile-verified native archive and extract only the requested binary. */
export async function materializeNativePackage({ root, name, version, filename }) {
  const lockfile = parseLockfile(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'))
  const integrity = lockfile.packages?.[`${name}@${version}`]?.resolution?.integrity
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) {
    throw new Error(`The lockfile does not pin ${name}@${version}`)
  }
  const basename = name.split('/').at(-1)
  const url = `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`
  const cache = join(root, 'out', '.orcad-native-packages', name, version)
  const archivePath = join(cache, 'package.tgz')
  await mkdir(cache, { recursive: true })
  let bytes
  try {
    bytes = await readFile(archivePath)
    verifyArchive(bytes, integrity)
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`Native package download failed: ${response.status} ${response.statusText}`)
    }
    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      length += chunk.length
      if (length > archiveLimit) {
        throw new Error('Native package archive exceeds the size limit')
      }
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
    verifyArchive(bytes, integrity)
    await writeFile(archivePath, bytes)
  }
  let extracted = false
  await extractTar({
    file: archivePath,
    cwd: cache,
    strict: true,
    filter: (path, entry) => {
      const expected = path === `package/${filename}` && entry.type === 'File'
      if (expected) {
        extracted = true
      }
      return expected
    }
  })
  if (!extracted) {
    throw new Error(`Native package ${name}@${version} does not contain a regular ${filename}`)
  }
  return join(cache, 'package', filename)
}
