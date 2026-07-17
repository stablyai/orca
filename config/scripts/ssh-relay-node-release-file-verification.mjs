import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import { validateSshRelayNodeReleaseContract } from './ssh-relay-node-release-contract.mjs'

async function assertBoundedRegularFile(filePath, maximumBytes, label) {
  const metadata = await stat(filePath)
  if (!metadata.isFile()) {
    throw new Error(`${label} must be a regular file`)
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} exceeds its size limit`)
  }
  return metadata
}

export async function readBoundedFile(filePath, maximumBytes, label) {
  await assertBoundedRegularFile(filePath, maximumBytes, label)
  const chunks = []
  let bytes = 0
  const stream = createReadStream(filePath)
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > maximumBytes) {
        throw new Error(`${label} exceeds its size limit`)
      }
      chunks.push(chunk)
    }
  } catch (error) {
    stream.destroy()
    throw error
  }
  if (bytes === 0) {
    throw new Error(`${label} must not be empty`)
  }
  return Buffer.concat(chunks, bytes)
}

export async function hashBoundedFile(filePath, maximumBytes, label) {
  await assertBoundedRegularFile(filePath, maximumBytes, label)

  const digest = createHash('sha256')
  let bytes = 0
  const stream = createReadStream(filePath)
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > maximumBytes) {
        throw new Error(`${label} exceeds its size limit`)
      }
      digest.update(chunk)
    }
  } catch (error) {
    stream.destroy()
    throw error
  }
  if (bytes === 0) {
    throw new Error(`${label} must not be empty`)
  }
  return { bytes, sha256: digest.digest('hex') }
}

export async function verifySshRelayNodeArchive(releaseInput, tuple, archivePath) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  const archive = release.archives[tuple]
  if (archive === undefined) {
    throw new Error(`Unknown Node archive tuple: ${String(tuple)}`)
  }
  const result = await hashBoundedFile(archivePath, release.maximumArchiveBytes, 'Node archive')
  if (result.sha256 !== archive.sha256) {
    throw new Error(`Node archive SHA-256 mismatch for ${tuple}`)
  }
  return { tuple, name: archive.name, ...result }
}

export async function verifySshRelayNodeWindowsBuildInput(releaseInput, kind, tuple, inputPath) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  const input =
    kind === 'headers'
      ? release.windowsBuildInputs.headersArchive
      : kind === 'import-library'
        ? release.windowsBuildInputs.importLibraries[tuple]
        : undefined
  if (!input) {
    throw new Error(`Unknown Node Windows build input: ${kind}/${String(tuple)}`)
  }
  const result = await hashBoundedFile(
    inputPath,
    release.maximumArchiveBytes,
    `Node Windows ${kind}`
  )
  if (result.sha256 !== input.sha256) {
    throw new Error(`Node Windows ${kind} SHA-256 mismatch for ${String(tuple)}`)
  }
  return { kind, tuple: kind === 'headers' ? undefined : tuple, name: input.name, ...result }
}
