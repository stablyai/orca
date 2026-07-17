import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { EXPECTED_TUPLES } from './ssh-relay-node-release-contract.mjs'
import { readBoundedFile } from './ssh-relay-node-release-file-verification.mjs'
import {
  validateSshRelayNodeReleaseContract,
  verifySshRelayNodeArchive,
  verifySshRelayNodeChecksumDocument,
  verifySshRelayNodeSignature,
  verifySshRelayNodeWindowsBuildInput
} from './ssh-relay-node-release-verification.mjs'

const scriptDirectory = import.meta.dirname
const DEFAULT_CONTRACT_PATH = resolve(scriptDirectory, '..', 'ssh-relay-node-release-v24.18.0.json')

function takeValue(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseArguments(argv) {
  let contractPath = DEFAULT_CONTRACT_PATH
  let inputsDirectory
  let allArchives = false
  const archiveTuples = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--contract') {
      contractPath = resolve(takeValue(argv, index, argument))
      index += 1
    } else if (argument === '--inputs-directory') {
      if (inputsDirectory !== undefined) {
        throw new Error('--inputs-directory may be specified once')
      }
      inputsDirectory = resolve(takeValue(argv, index, argument))
      index += 1
    } else if (argument === '--archive') {
      archiveTuples.push(takeValue(argv, index, argument))
      index += 1
    } else if (argument === '--all-archives') {
      allArchives = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (inputsDirectory === undefined) {
    throw new Error('--inputs-directory is required')
  }
  if (allArchives && archiveTuples.length > 0) {
    throw new Error('--all-archives cannot be combined with --archive')
  }
  const selectedTuples = allArchives ? [...EXPECTED_TUPLES] : archiveTuples
  if (new Set(selectedTuples).size !== selectedTuples.length) {
    throw new Error('Archive tuples must not be duplicated')
  }
  for (const tuple of selectedTuples) {
    if (!EXPECTED_TUPLES.includes(tuple)) {
      throw new Error(`Unknown archive tuple: ${tuple}`)
    }
  }
  return { contractPath, inputsDirectory, archiveTuples: selectedTuples }
}

async function loadContract(contractPath) {
  const source = await readFile(contractPath, 'utf8')
  let contract
  try {
    contract = JSON.parse(source)
  } catch (error) {
    throw new Error(`Node release contract is not valid JSON: ${error.message}`)
  }
  return validateSshRelayNodeReleaseContract(contract)
}

export async function verifyNodeReleaseInputs(
  { contractPath, inputsDirectory, archiveTuples },
  { commandRunner } = {}
) {
  const release = await loadContract(contractPath)
  const checksumPath = join(inputsDirectory, release.checksumDocument.name)
  const signaturePath = join(inputsDirectory, release.signature.name)
  const keyPath = isAbsolute(release.signature.key.path)
    ? release.signature.key.path
    : resolve(dirname(contractPath), release.signature.key.path)

  const signature = await verifySshRelayNodeSignature(release, {
    checksumPath,
    signaturePath,
    keyPath,
    commandRunner
  })
  const checksumBytes = await readBoundedFile(
    checksumPath,
    release.checksumDocument.maximumBytes,
    'Node checksum document'
  )
  const checksums = verifySshRelayNodeChecksumDocument(release, checksumBytes)
  const archives = []
  const windowsBuildInputs = []
  for (const tuple of archiveTuples) {
    const archive = release.archives[tuple]
    archives.push(
      await verifySshRelayNodeArchive(release, tuple, join(inputsDirectory, archive.name))
    )
    if (tuple.startsWith('win32-')) {
      const headers = release.windowsBuildInputs.headersArchive
      const library = release.windowsBuildInputs.importLibraries[tuple]
      if (!windowsBuildInputs.some((input) => input.kind === 'headers')) {
        windowsBuildInputs.push(
          await verifySshRelayNodeWindowsBuildInput(
            release,
            'headers',
            tuple,
            join(inputsDirectory, headers.name)
          )
        )
      }
      windowsBuildInputs.push(
        await verifySshRelayNodeWindowsBuildInput(
          release,
          'import-library',
          tuple,
          join(inputsDirectory, ...library.name.split('/'))
        )
      )
    }
  }

  return {
    schemaVersion: release.schemaVersion,
    nodeVersion: release.nodeVersion,
    baseUrl: release.baseUrl,
    signerFingerprint: signature.signerFingerprint,
    checksumSha256: signature.checksumSha256,
    checksumEntriesVerified: checksums.length,
    archives,
    windowsBuildInputs
  }
}

async function main() {
  const result = await verifyNodeReleaseInputs(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`SSH relay Node release verification failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
