import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { checkModuleTrailer } from './ci-unit-module-cache-trailer.mjs'

export const MODULE_CACHE_MANIFEST = '_orca_manifest.json'
export const MODULE_CACHE_LIMITS = Object.freeze({
  entries: 50_000,
  totalBytes: 2 ** 30,
  entryBytes: 32 * 2 ** 20
})
const METADATA = '_metadata.json'
const MODULE_NAME = /^[a-f0-9]{40}$/
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (message) => {
  throw new Error(`Unit module cache: ${message}`)
}

async function readRegularFile(path) {
  const before = await lstat(path)
  if (!before.isFile()) {
    fail(`not a regular file: ${path}`)
  }
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MODULE_CACHE_LIMITS.entryBytes) {
      fail(`invalid file size or type: ${path}`)
    }
    const buffer = Buffer.alloc(info.size + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!result.bytesRead) {
        break
      }
      bytes += result.bytesRead
    }
    if (bytes !== info.size) {
      fail(`file changed while reading: ${path}`)
    }
    return buffer.subarray(0, bytes)
  } finally {
    await file.close()
  }
}

function checkLockfileHash(lockfileHash) {
  if (typeof lockfileHash !== 'string' || !/^[a-f0-9]{8}$/.test(lockfileHash)) {
    fail('invalid expected lockfile hash')
  }
}

export async function inventoryModuleCache({ path, lockfileHash }) {
  checkLockfileHash(lockfileHash)
  if (!(await lstat(path)).isDirectory()) {
    fail('cache root is not a regular directory')
  }
  const names = (await readdir(path)).sort()
  if (names.length > MODULE_CACHE_LIMITS.entries) {
    fail('too many cache entries')
  }
  if (!names.includes(METADATA)) {
    fail('cache metadata is missing')
  }
  let totalBytes = 0
  let manifestBytes = 0
  const entries = Array.from({ length: names.length })
  let next = 0
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(4, names.length) }, async () => {
      while (next < names.length) {
        const index = next++
        const name = names[index]
        if (name !== METADATA && name !== MODULE_CACHE_MANIFEST && !MODULE_NAME.test(name)) {
          fail(`invalid cache entry name: ${name}`)
        }
        const buffer = await readRegularFile(join(path, name))
        if (name === MODULE_CACHE_MANIFEST) {
          manifestBytes = buffer.length
        } else {
          totalBytes += buffer.length
        }
        if (totalBytes + manifestBytes > MODULE_CACHE_LIMITS.totalBytes) {
          fail('cache byte limit exceeded')
        }
        if (name === MODULE_CACHE_MANIFEST) {
          continue
        }
        if (name === METADATA) {
          const metadata = JSON.parse(buffer.toString('utf8'))
          if (!isRecord(metadata) || metadata.lockfileHash !== lockfileHash) {
            fail('cache lockfile hash mismatch')
          }
        } else {
          checkModuleTrailer(buffer)
        }
        entries[index] = {
          name,
          bytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex')
        }
      }
    })
  )
  const failure = workers.find((result) => result.status === 'rejected')
  if (failure) {
    throw failure.reason
  }
  return { entries: entries.filter(Boolean), totalBytes }
}

function checkIdentity({ key, format, versions, sourceSha, lockfileHash }) {
  checkLockfileHash(lockfileHash)
  if (typeof key !== 'string' || !key || typeof format !== 'string' || !format) {
    fail('invalid cache identity')
  }
  if (
    !isRecord(versions) ||
    !['node', 'bun', 'vitest'].every((name) => typeof versions[name] === 'string' && versions[name])
  ) {
    fail('invalid cache versions')
  }
  if (sourceSha !== undefined && (typeof sourceSha !== 'string' || !MODULE_NAME.test(sourceSha))) {
    fail('invalid source SHA')
  }
}

export async function sealModuleCache(options) {
  checkIdentity(options)
  if (!options.sourceSha) {
    fail('source SHA is required when sealing')
  }
  const inventory = await inventoryModuleCache(options)
  const manifest = {
    version: 1,
    key: options.key,
    format: options.format,
    versions: options.versions,
    sourceSha: options.sourceSha,
    lockfileHash: options.lockfileHash,
    ...inventory
  }
  const content = `${JSON.stringify(manifest)}\n`
  if (
    Buffer.byteLength(content) > MODULE_CACHE_LIMITS.entryBytes ||
    inventory.totalBytes + Buffer.byteLength(content) > MODULE_CACHE_LIMITS.totalBytes ||
    inventory.entries.length + 1 > MODULE_CACHE_LIMITS.entries
  ) {
    fail('sealed cache exceeds limits')
  }
  const file = await open(
    join(options.path, MODULE_CACHE_MANIFEST),
    constants.O_WRONLY |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600
  )
  try {
    if (!(await file.stat()).isFile()) {
      fail('manifest is not a regular file')
    }
    await file.truncate(0)
    await file.writeFile(content)
  } finally {
    await file.close()
  }
  return manifest
}

export async function validateModuleCache(options) {
  checkIdentity(options)
  const manifest = JSON.parse(
    (await readRegularFile(join(options.path, MODULE_CACHE_MANIFEST))).toString('utf8')
  )
  if (!isRecord(manifest)) {
    fail('invalid cache manifest')
  }
  checkIdentity(manifest)
  if (
    !manifest.sourceSha ||
    manifest.version !== 1 ||
    manifest.key !== options.key ||
    manifest.format !== options.format ||
    manifest.lockfileHash !== options.lockfileHash ||
    (options.sourceSha !== undefined && manifest.sourceSha !== options.sourceSha) ||
    !['node', 'bun', 'vitest'].every((name) => manifest.versions[name] === options.versions[name])
  ) {
    fail('cache manifest identity mismatch')
  }
  const inventory = await inventoryModuleCache(options)
  if (
    manifest.totalBytes !== inventory.totalBytes ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== inventory.entries.length
  ) {
    fail('cache inventory mismatch')
  }
  for (let index = 0; index < inventory.entries.length; index++) {
    const expected = manifest.entries[index]
    const actual = inventory.entries[index]
    if (
      !isRecord(expected) ||
      expected.name !== actual.name ||
      expected.bytes !== actual.bytes ||
      expected.sha256 !== actual.sha256
    ) {
      fail(`cache content mismatch: ${actual.name}`)
    }
  }
  return manifest
}
