import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { x as extractTar } from 'tar'
import { parseAllDocuments } from 'yaml'
import { ORCAD_BUN_TARGETS } from '../../src/shared/orcad-bun-runtime.ts'

const root = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const archiveLimit = 16 * 1024 * 1024

export function parseWatcherLockfile(contents) {
  const packages = {}
  for (const document of parseAllDocuments(contents)) {
    if (document.errors.length) {
      throw document.errors[0]
    }
    Object.assign(packages, document.toJS()?.packages)
  }
  return { packages }
}

export function watcherPackageIdentity(target, version, lockfile) {
  if (!ORCAD_BUN_TARGETS.includes(target)) {
    throw new Error(`Unsupported watcher target: ${target}`)
  }
  const name = `@parcel/watcher-${target}`
  const integrity = lockfile.packages?.[`${name}@${version}`]?.resolution?.integrity
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) {
    throw new Error(`The lockfile does not pin ${name}@${version}`)
  }
  return {
    integrity,
    url: `https://registry.npmjs.org/${name}/-/watcher-${target}-${version}.tgz`
  }
}

export function verifyWatcherArchive(bytes, integrity) {
  if (bytes.length > archiveLimit) {
    throw new Error('Watcher archive exceeds the size limit')
  }
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) {
    throw new Error('Watcher archive does not match the lockfile integrity')
  }
}

// Fetch only these small release assets; ordinary installs remain host-only.
export async function materializeWatcherPackage(target) {
  const { version } = require('@parcel/watcher/package.json')
  const lockfile = parseWatcherLockfile(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'))
  const { integrity, url } = watcherPackageIdentity(target, version, lockfile)
  const cache = join(root, 'out', '.orcad-watchers', version, target)
  const archivePath = join(cache, 'package.tgz')
  await mkdir(cache, { recursive: true })
  let bytes
  try {
    bytes = await readFile(archivePath)
    verifyWatcherArchive(bytes, integrity)
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`Watcher download failed: ${response.status} ${response.statusText}`)
    }
    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      length += chunk.length
      if (length > archiveLimit) {
        throw new Error('Watcher archive exceeds the size limit')
      }
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
    verifyWatcherArchive(bytes, integrity)
    await writeFile(archivePath, bytes)
  }
  await extractTar({
    file: archivePath,
    cwd: cache,
    strict: true,
    filter: (path, entry) => path === 'package/watcher.node' && entry.type === 'File'
  })
  return join(cache, 'package', 'watcher.node')
}
