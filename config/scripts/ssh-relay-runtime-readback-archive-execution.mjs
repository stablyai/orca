import { readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { extractSshRelayRuntimeArchive } from './ssh-relay-runtime-archive-extraction.mjs'
import { verifyExtractedSshRelayRuntime } from './verify-ssh-relay-runtime.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const MATERIALIZED_ARCHIVE_FIELDS = ['name', 'path', 'sha256', 'size']
const ARGUMENT_FIELDS = new Map([
  ['--identity', 'identityPath'],
  ['--archive', 'archivePath'],
  ['--output-directory', 'outputDirectory']
])

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime read-back archive execution ${label} must be an object`)
  }
}

async function exactMaterializedArchive(materializedArchive, identity) {
  assertObject(identity, 'identity')
  assertObject(identity.archive, 'identity archive')
  assertObject(materializedArchive, 'materialized archive')
  if (
    JSON.stringify(Object.keys(materializedArchive).sort()) !==
    JSON.stringify([...MATERIALIZED_ARCHIVE_FIELDS].sort())
  ) {
    throw new Error(
      'SSH relay runtime read-back archive execution materialized archive fields are invalid'
    )
  }
  if (
    typeof materializedArchive.name !== 'string' ||
    typeof materializedArchive.path !== 'string' ||
    !isAbsolute(materializedArchive.path) ||
    resolve(materializedArchive.path) !== materializedArchive.path ||
    typeof materializedArchive.sha256 !== 'string' ||
    !DIGEST_PATTERN.test(materializedArchive.sha256) ||
    !Number.isSafeInteger(materializedArchive.size) ||
    materializedArchive.size <= 0 ||
    materializedArchive.name !== identity.archive.name ||
    materializedArchive.sha256 !== identity.archive.sha256 ||
    materializedArchive.size !== identity.archive.size ||
    basename(materializedArchive.path) !== materializedArchive.name
  ) {
    throw new Error(
      'SSH relay runtime read-back archive execution materialized archive identity drifted'
    )
  }
  const physicalParent = resolve(await realpath(dirname(materializedArchive.path)))
  const physicalPath = resolve(physicalParent, basename(materializedArchive.path))
  if (physicalPath !== materializedArchive.path) {
    throw new Error(
      'SSH relay runtime read-back archive execution requires a physical materialized path'
    )
  }
  return { ...materializedArchive }
}

async function physicalOutputDirectory(outputDirectory) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
    throw new Error('SSH relay runtime read-back archive execution output directory is required')
  }
  const absolute = resolve(outputDirectory)
  const physicalParent = resolve(await realpath(dirname(absolute)))
  return resolve(physicalParent, basename(absolute))
}

export function parseSshRelayRuntimeReadbackArchiveExecutionArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = ARGUMENT_FIELDS.get(flag)
    const value = argv[index + 1]
    if (!field || !value || value.startsWith('--') || result[field]) {
      throw new Error(`Invalid runtime read-back archive execution argument: ${flag}`)
    }
    result[field] = resolve(value)
  }
  if (Object.keys(result).length !== ARGUMENT_FIELDS.size) {
    throw new Error('Runtime read-back archive execution requires identity, archive, and output')
  }
  return result
}

export async function executeSshRelayRuntimeReadbackArchive({
  identity,
  materializedArchive,
  outputDirectory,
  signal,
  extractImpl = extractSshRelayRuntimeArchive,
  verifyImpl = verifyExtractedSshRelayRuntime
}) {
  signal?.throwIfAborted()
  const archive = await exactMaterializedArchive(materializedArchive, identity)
  const expectedRuntimeRoot = await physicalOutputDirectory(outputDirectory)
  let extractedRuntime
  try {
    const extracted = await extractImpl({
      archivePath: archive.path,
      outputDirectory: expectedRuntimeRoot,
      identity,
      signal
    })
    // Why: a successful extractor owns this exclusive path, so later failures may safely remove it.
    extractedRuntime = expectedRuntimeRoot
    if (
      extracted?.tupleId !== identity.tupleId ||
      extracted?.runtimeRoot !== expectedRuntimeRoot ||
      extracted?.tree?.contentId !== identity.contentId
    ) {
      throw new Error('SSH relay runtime read-back archive extraction identity drifted')
    }
    signal?.throwIfAborted()
    const verified = await verifyImpl({
      runtimeDirectory: extracted.runtimeRoot,
      identity,
      archivePath: archive.path,
      signal
    })
    signal?.throwIfAborted()
    if (
      verified?.tuple !== identity.tupleId ||
      verified?.tree?.contentId !== identity.contentId ||
      verified?.smoke === null ||
      typeof verified?.smoke !== 'object'
    ) {
      throw new Error('SSH relay runtime read-back archive execution identity drifted')
    }
    return {
      tupleId: identity.tupleId,
      contentId: identity.contentId,
      archive,
      runtimeRoot: extracted.runtimeRoot,
      tree: verified.tree,
      smoke: verified.smoke,
      durationMs: verified.durationMs
    }
  } catch (error) {
    if (extractedRuntime) {
      // Why: a downloaded archive may be retained only after complete bundled-native execution.
      await rm(extractedRuntime, { recursive: true, force: true })
    }
    throw error
  }
}

export async function executeSshRelayRuntimeReadbackArchiveFromPaths({
  identityPath,
  archivePath,
  outputDirectory,
  signal,
  extractImpl,
  verifyImpl
}) {
  const [identityBytes, physicalArchivePath] = await Promise.all([
    readFile(identityPath, { encoding: 'utf8', signal }),
    realpath(archivePath)
  ])
  const identity = JSON.parse(identityBytes)
  // Why: runner temp roots may be aliases; the execution boundary accepts only physical paths.
  return executeSshRelayRuntimeReadbackArchive({
    identity,
    materializedArchive: {
      name: identity.archive?.name,
      path: physicalArchivePath,
      sha256: identity.archive?.sha256,
      size: identity.archive?.size
    },
    outputDirectory,
    signal,
    extractImpl,
    verifyImpl
  })
}

async function main() {
  const options = parseSshRelayRuntimeReadbackArchiveExecutionArguments(process.argv.slice(2))
  const result = await executeSshRelayRuntimeReadbackArchiveFromPaths(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `SSH relay runtime read-back archive execution failed: ${error.stack ?? error}\n`
    )
    process.exitCode = 1
  })
}
