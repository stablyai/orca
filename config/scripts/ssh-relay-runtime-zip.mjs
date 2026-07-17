import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import yazl from 'yazl'

import { visitSshRelayZip } from './ssh-relay-zip-reader.mjs'

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const ZIP_LIMITS = Object.freeze({
  maximumArchiveBytes: MAX_ARCHIVE_BYTES,
  maximumEntries: 5_000,
  maximumExpandedBytes: 350 * 1024 * 1024,
  maximumFileBytes: 250 * 1024 * 1024,
  maximumDepth: 32,
  maximumPathBytes: 240
})

function archiveName(tuple, contentId) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(contentId)
  if (!match) {
    throw new Error('Runtime content identity is not a SHA-256 digest')
  }
  if (!tuple.startsWith('win32-')) {
    throw new Error(`Runtime ZIP is only valid for a Windows tuple: ${tuple}`)
  }
  return `orca-ssh-relay-runtime-v1-${tuple}-${match[1]}.zip`
}

function zipTimestamp(sourceDateEpoch) {
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 315_532_800) {
    throw new Error('Runtime ZIP SOURCE_DATE_EPOCH must fit the ZIP timestamp range')
  }
  const value = new Date(sourceDateEpoch * 1000)
  if (Number.isNaN(value.getTime()) || value.getUTCFullYear() > 2107) {
    throw new Error('Runtime ZIP SOURCE_DATE_EPOCH must fit the ZIP timestamp range')
  }
  return value
}

async function sha256File(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk)
  }
  return `sha256:${digest.digest('hex')}`
}

export async function createSshRelayRuntimeZip({
  runtimeRoot,
  outputDirectory,
  identity,
  sourceDateEpoch,
  signal
}) {
  const name = archiveName(identity.tupleId, identity.contentId)
  const archivePath = join(outputDirectory, name)
  const mtime = zipTimestamp(sourceDateEpoch)
  const zip = new yazl.ZipFile()
  const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
  try {
    for (const entry of [...identity.entries].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    )) {
      signal?.throwIfAborted()
      const options = { mtime, mode: entry.mode, forceDosTimestamp: true }
      if (entry.type === 'directory') {
        zip.addEmptyDirectory(entry.path, options)
      } else {
        zip.addFile(join(runtimeRoot, ...entry.path.split('/')), entry.path, {
          ...options,
          compress: true,
          compressionLevel: 9
        })
      }
    }
    zip.end({ forceZip64Format: false })
    await pipeline(zip.outputStream, output, { signal })
    const metadata = await stat(archivePath)
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_ARCHIVE_BYTES) {
      throw new Error('Runtime ZIP exceeds the release-manifest compressed-size limit')
    }
    return {
      name,
      path: archivePath,
      size: metadata.size,
      sha256: await sha256File(archivePath)
    }
  } catch (error) {
    zip.outputStream.destroy()
    output.destroy()
    await rm(archivePath, { force: true })
    throw error
  }
}

export async function inspectSshRelayRuntimeZip(archivePath, identity, { signal } = {}) {
  const expected = new Map(identity.entries.map((entry) => [entry.path, entry]))
  const seen = new Set()
  const result = await visitSshRelayZip(
    archivePath,
    ZIP_LIMITS,
    async (actual, consume) => {
      const declared = expected.get(actual.path)
      if (!declared || seen.has(actual.path)) {
        throw new Error(`Runtime ZIP has extra or duplicate entry: ${actual.path}`)
      }
      seen.add(actual.path)
      if (
        actual.type !== declared.type ||
        actual.unixMode === null ||
        (actual.unixMode & 0o777) !== declared.mode
      ) {
        throw new Error(`Runtime ZIP type or mode mismatch: ${actual.path}`)
      }
      if (declared.type === 'file') {
        if (actual.size !== declared.size) {
          throw new Error(`Runtime ZIP size mismatch: ${actual.path}`)
        }
        const verified = await consume()
        if (verified.sha256 !== declared.sha256) {
          throw new Error(`Runtime ZIP file integrity mismatch: ${actual.path}`)
        }
      }
    },
    { signal }
  )
  const missing = [...expected.keys()].find((path) => !seen.has(path))
  if (missing) {
    throw new Error(`Runtime ZIP is missing declared entry: ${missing}`)
  }
  if (result.files !== identity.fileCount || result.expandedBytes !== identity.expandedSize) {
    throw new Error('Runtime ZIP aggregate size or file-count mismatch')
  }
  return result
}

export async function extractSshRelayRuntimeZip({
  archivePath,
  outputDirectory,
  identity,
  signal
}) {
  const expected = new Map(identity.entries.map((entry) => [entry.path, entry]))
  const seen = new Set()
  const result = await visitSshRelayZip(
    archivePath,
    ZIP_LIMITS,
    async (actual, consume) => {
      const declared = expected.get(actual.path)
      if (!declared || seen.has(actual.path)) {
        throw new Error(`Runtime ZIP has extra or duplicate entry: ${actual.path}`)
      }
      seen.add(actual.path)
      if (
        actual.type !== declared.type ||
        actual.unixMode === null ||
        (actual.unixMode & 0o777) !== declared.mode
      ) {
        throw new Error(`Runtime ZIP type or mode mismatch: ${actual.path}`)
      }
      const outputPath = join(outputDirectory, ...actual.path.split('/'))
      if (declared.type === 'directory') {
        await mkdir(outputPath, { recursive: true, mode: declared.mode })
        if (process.platform !== 'win32') {
          await chmod(outputPath, declared.mode)
        }
        return
      }
      if (actual.size !== declared.size) {
        throw new Error(`Runtime ZIP size mismatch: ${actual.path}`)
      }
      const extracted = await consume({ outputPath, mode: declared.mode })
      if (extracted.sha256 !== declared.sha256) {
        throw new Error(`Runtime ZIP file integrity mismatch: ${actual.path}`)
      }
      if (process.platform !== 'win32') {
        await chmod(outputPath, declared.mode)
      }
    },
    { signal }
  )
  const missing = [...expected.keys()].find((path) => !seen.has(path))
  if (missing) {
    throw new Error(`Runtime ZIP is missing declared entry: ${missing}`)
  }
  if (result.files !== identity.fileCount || result.expandedBytes !== identity.expandedSize) {
    throw new Error('Runtime ZIP aggregate size or file-count mismatch')
  }
  return result
}
