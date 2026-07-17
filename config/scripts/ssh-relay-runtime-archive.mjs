import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, createBrotliCompress, createBrotliDecompress } from 'node:zlib'

import { create, Parser } from 'tar'

import { createSshRelayRuntimeZip, inspectSshRelayRuntimeZip } from './ssh-relay-runtime-zip.mjs'

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000
const BROTLI_CHUNK_BYTES = 64 * 1024
const BROTLI_QUALITY = 9
const BROTLI_WINDOW_BITS = 20

function archiveName(tuple, contentId) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(contentId)
  if (!match) {
    throw new Error('Runtime content identity is not a SHA-256 digest')
  }
  const suffix = tuple.startsWith('win32-') ? 'zip' : 'tar.br'
  return `orca-ssh-relay-runtime-v1-${tuple}-${match[1]}.${suffix}`
}

async function compressRuntimeTree({
  runtimeRoot,
  paths,
  sourceDateEpoch,
  archivePath,
  signal,
  markOutputCreated
}) {
  const archiveOutput = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
  archiveOutput.once('open', markOutputCreated)
  const tarStream = create(
    {
      cwd: runtimeRoot,
      portable: true,
      noPax: true,
      noDirRecurse: true,
      mtime: new Date(sourceDateEpoch * 1000)
    },
    paths
  )
  const compression = createBrotliCompress({
    chunkSize: BROTLI_CHUNK_BYTES,
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlibConstants.BROTLI_PARAM_LGWIN]: BROTLI_WINDOW_BITS
    }
  })
  await pipeline(tarStream, compression, archiveOutput, { signal })
}

async function decompressArchive(archivePath, destination, signal) {
  await pipeline(
    createReadStream(archivePath, { highWaterMark: BROTLI_CHUNK_BYTES }),
    createBrotliDecompress({ chunkSize: BROTLI_CHUNK_BYTES }),
    destination,
    { signal }
  )
}

export async function createSshRelayRuntimeArchive({
  runtimeRoot,
  outputDirectory,
  identity,
  sourceDateEpoch,
  signal
}) {
  if (identity.tupleId.startsWith('win32-')) {
    return createSshRelayRuntimeZip({
      runtimeRoot,
      outputDirectory,
      identity,
      sourceDateEpoch,
      signal
    })
  }
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error('Runtime archive SOURCE_DATE_EPOCH must be a non-negative safe integer')
  }
  const name = archiveName(identity.tupleId, identity.contentId)
  const archivePath = join(outputDirectory, name)
  const timeoutSignal = AbortSignal.timeout(ARCHIVE_TIMEOUT_MS)
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  effectiveSignal.throwIfAborted()
  let outputCreated = false
  try {
    const paths = identity.entries.map((entry) => entry.path).sort()
    await compressRuntimeTree({
      runtimeRoot,
      paths,
      sourceDateEpoch,
      archivePath,
      signal: effectiveSignal,
      // Why: an exclusive-open failure must never delete an output owned by another build.
      markOutputCreated: () => {
        outputCreated = true
      }
    })
    const metadata = await stat(archivePath)
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_ARCHIVE_BYTES) {
      throw new Error('Runtime archive exceeds the release-manifest compressed-size limit')
    }
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(archivePath)) {
      digest.update(chunk)
    }
    return {
      name,
      path: archivePath,
      size: metadata.size,
      sha256: `sha256:${digest.digest('hex')}`
    }
  } catch (error) {
    if (outputCreated) {
      await rm(archivePath, { force: true })
    }
    throw error
  }
}

export async function inspectSshRelayRuntimeArchive(archivePath, identity, { signal } = {}) {
  if (identity.tupleId.startsWith('win32-')) {
    return inspectSshRelayRuntimeZip(archivePath, identity, { signal })
  }
  const metadata = await stat(archivePath)
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_ARCHIVE_BYTES) {
    throw new Error('Runtime archive exceeds the release-manifest compressed-size limit')
  }
  const expected = new Map(identity.entries.map((entry) => [entry.path, entry]))
  const seen = new Set()
  const pendingFiles = []
  const parser = new Parser({ strict: true })
  parser.on('entry', (entry) => {
    const path = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
    const expectedEntry = expected.get(path)
    try {
      if (!expectedEntry || seen.has(path)) {
        throw new Error(`Runtime archive has extra or duplicate entry: ${path}`)
      }
      seen.add(path)
      const expectedType = expectedEntry.type === 'file' ? 'File' : 'Directory'
      if (entry.type !== expectedType || (entry.mode & 0o777) !== expectedEntry.mode) {
        throw new Error(`Runtime archive type or mode mismatch: ${path}`)
      }
      if (expectedEntry.type === 'file') {
        if (entry.size !== expectedEntry.size) {
          throw new Error(`Runtime archive size mismatch: ${path}`)
        }
        const digest = createHash('sha256')
        entry.on('data', (chunk) => digest.update(chunk))
        pendingFiles.push(
          new Promise((resolve, reject) => {
            entry.once('error', reject)
            entry.once('end', () => {
              const actual = `sha256:${digest.digest('hex')}`
              if (actual !== expectedEntry.sha256) {
                reject(new Error(`Runtime archive SHA-256 mismatch: ${path}`))
              } else {
                resolve()
              }
            })
          })
        )
      } else {
        entry.resume()
      }
    } catch (error) {
      parser.abort(error)
    }
  })
  const timeoutSignal = AbortSignal.timeout(ARCHIVE_TIMEOUT_MS)
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  effectiveSignal.throwIfAborted()
  await decompressArchive(archivePath, parser, effectiveSignal)
  await Promise.all(pendingFiles)
  const missing = [...expected.keys()].filter((path) => !seen.has(path))
  if (missing.length > 0) {
    throw new Error(`Runtime archive is missing declared entry: ${missing[0]}`)
  }
  return {
    entries: seen.size,
    files: identity.entries.filter((entry) => entry.type === 'file').length,
    expandedBytes: identity.expandedSize
  }
}

export const SSH_RELAY_RUNTIME_POSIX_ARCHIVE_LIMITS = Object.freeze({
  chunkBytes: BROTLI_CHUNK_BYTES,
  quality: BROTLI_QUALITY,
  windowBits: BROTLI_WINDOW_BITS
})
