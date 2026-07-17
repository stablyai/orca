import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createBrotliDecompress } from 'node:zlib'

import { extract } from 'tar'

import {
  inspectSshRelayRuntimeArchive,
  SSH_RELAY_RUNTIME_POSIX_ARCHIVE_LIMITS
} from './ssh-relay-runtime-archive.mjs'
import { assertSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { readSshRelayRuntimeNativeSigningIdentity } from './ssh-relay-runtime-native-signing-plan.mjs'
import { extractSshRelayRuntimeZip } from './ssh-relay-runtime-zip.mjs'
import { verifyRuntimeTree } from './verify-ssh-relay-runtime.mjs'

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const EXTRACTION_TIMEOUT_MS = 5 * 60_000

function expectedArchiveName(identity) {
  const extension = identity.os === 'win32' ? 'zip' : 'tar.br'
  return `orca-ssh-relay-runtime-v1-${identity.tupleId}-${identity.contentId.slice('sha256:'.length)}.${extension}`
}

function sourceIdentity(identity) {
  const { archive: _archive, ...candidate } = identity
  return candidate
}

function assertIdentityArchive(identity, archivePath) {
  assertSshRelayRuntimeClosureEntries(identity)
  const candidate = sourceIdentity(identity)
  if (
    computeSshRelayRuntimeContentId(candidate) !== identity.contentId ||
    identity.archive?.name !== expectedArchiveName(identity) ||
    basename(archivePath) !== identity.archive.name ||
    !Number.isSafeInteger(identity.archive.size) ||
    identity.archive.size <= 0 ||
    identity.archive.size > MAX_ARCHIVE_BYTES ||
    identity.archive.expandedSize !== identity.expandedSize ||
    identity.archive.fileCount !== identity.fileCount ||
    !/^sha256:[0-9a-f]{64}$/u.test(identity.archive.sha256 ?? '')
  ) {
    throw new Error('Runtime archive extraction identity or archive reference is inconsistent')
  }
  return candidate
}

function sameFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function describeArchive(path, maximumBytes, signal) {
  signal.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new Error('Runtime archive extraction input must be one bounded regular file')
  }
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path, { signal })) {
    size += chunk.length
    if (size > maximumBytes) {
      throw new Error('Runtime archive extraction input exceeds its size bound')
    }
    hash.update(chunk)
  }
  const after = await lstat(path, { bigint: true })
  if (!sameFileState(before, after) || BigInt(size) !== before.size) {
    throw new Error('Runtime archive extraction input changed while hashing')
  }
  return { size, sha256: `sha256:${hash.digest('hex')}`, state: after }
}

async function assertOutputAbsent(outputDirectory) {
  try {
    await lstat(outputDirectory)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error('Runtime archive extraction requires an exclusive output directory')
}

async function extractTarBrotli(archivePath, outputDirectory, signal) {
  const unpack = extract({
    cwd: outputDirectory,
    strict: true,
    preserveOwner: false,
    noChmod: false,
    unlink: false
  })
  await pipeline(
    createReadStream(archivePath, {
      highWaterMark: SSH_RELAY_RUNTIME_POSIX_ARCHIVE_LIMITS.chunkBytes
    }),
    createBrotliDecompress({
      chunkSize: SSH_RELAY_RUNTIME_POSIX_ARCHIVE_LIMITS.chunkBytes
    }),
    unpack,
    { signal }
  )
}

export async function extractSshRelayRuntimeArchive({
  archivePath,
  outputDirectory,
  identity,
  signal
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(EXTRACTION_TIMEOUT_MS)])
    : AbortSignal.timeout(EXTRACTION_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  const absoluteArchive = resolve(archivePath)
  const absoluteOutput = resolve(outputDirectory)
  const finalIdentity = assertIdentityArchive(identity, absoluteArchive)
  const outputParent = dirname(absoluteOutput)
  // Why: clean signing/floor runners supply a fresh parent; only the final staging leaf is exclusive.
  await mkdir(outputParent, { recursive: true, mode: 0o700 })
  const physicalParent = await realpath(outputParent)
  const physicalOutput = resolve(physicalParent, basename(absoluteOutput))
  await assertOutputAbsent(physicalOutput)
  const before = await describeArchive(absoluteArchive, identity.archive.size, effectiveSignal)
  if (before.size !== identity.archive.size || before.sha256 !== identity.archive.sha256) {
    throw new Error('Runtime archive extraction input size or digest mismatch')
  }
  await inspectSshRelayRuntimeArchive(absoluteArchive, finalIdentity, { signal: effectiveSignal })

  let outputCreated = false
  try {
    await mkdir(physicalOutput)
    outputCreated = true
    await (identity.os === 'win32'
      ? extractSshRelayRuntimeZip({
          archivePath: absoluteArchive,
          outputDirectory: physicalOutput,
          identity: finalIdentity,
          signal: effectiveSignal
        })
      : extractTarBrotli(absoluteArchive, physicalOutput, effectiveSignal))
    const tree = await verifyRuntimeTree(physicalOutput, finalIdentity, { signal: effectiveSignal })
    const after = await describeArchive(absoluteArchive, identity.archive.size, effectiveSignal)
    if (!sameFileState(before.state, after.state) || before.sha256 !== after.sha256) {
      throw new Error('Runtime archive extraction input changed during extraction')
    }
    return { tupleId: identity.tupleId, runtimeRoot: physicalOutput, tree }
  } catch (error) {
    if (outputCreated) {
      // Why: only a completely verified reconstruction may cross the native-signing boundary.
      await rm(physicalOutput, { recursive: true, force: true })
    }
    throw error
  }
}

const ARGUMENT_FIELDS = new Map([
  ['--identity', 'identityPath'],
  ['--archive', 'archivePath'],
  ['--output-directory', 'outputDirectory']
])

export function parseSshRelayRuntimeArchiveExtractionArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = ARGUMENT_FIELDS.get(flag)
    const value = argv[index + 1]
    if (!field || !value || value.startsWith('--') || result[field]) {
      throw new Error(`Invalid runtime archive extraction argument: ${flag}`)
    }
    result[field] = resolve(value)
  }
  if (Object.keys(result).length !== ARGUMENT_FIELDS.size) {
    throw new Error('Runtime archive extraction requires identity, archive, and output directory')
  }
  return result
}

async function main() {
  const options = parseSshRelayRuntimeArchiveExtractionArguments(process.argv.slice(2))
  const identity = await readSshRelayRuntimeNativeSigningIdentity(options.identityPath)
  const result = await extractSshRelayRuntimeArchive({ ...options, identity })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`SSH relay runtime archive extraction failed: ${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}

export const SSH_RELAY_RUNTIME_ARCHIVE_EXTRACTION_LIMITS = Object.freeze({
  maximumArchiveBytes: MAX_ARCHIVE_BYTES,
  timeoutMs: EXTRACTION_TIMEOUT_MS
})
