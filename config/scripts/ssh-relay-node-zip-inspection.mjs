import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { verifySshRelayNodeArchive } from './ssh-relay-node-release-file-verification.mjs'
import { extractVerifiedSshRelayNodeHeaders } from './ssh-relay-node-headers-extraction.mjs'
import { verifySshRelayNodeWindowsBuildInput } from './ssh-relay-node-release-file-verification.mjs'
import { validateSshRelayNodeReleaseContract } from './ssh-relay-node-release-contract.mjs'
import { visitSshRelayZip } from './ssh-relay-zip-reader.mjs'

const DEFAULT_LIMITS = Object.freeze({
  maximumArchiveBytes: 200 * 1024 * 1024,
  maximumEntries: 100_000,
  maximumExpandedBytes: 1024 * 1024 * 1024,
  maximumFileBytes: 256 * 1024 * 1024,
  maximumDepth: 32,
  maximumPathBytes: 512
})
const ZIP_TIMEOUT_MS = 5 * 60 * 1000

function archiveRoot(release, tuple) {
  const name = release.archives[tuple]?.name
  if (typeof name !== 'string' || !name.endsWith('.zip')) {
    throw new Error(`Node tuple ${String(tuple)} does not use a ZIP archive`)
  }
  return name.slice(0, -'.zip'.length)
}

function selectedBuildInput(root, path) {
  return path === `${root}/node.exe` || path === `${root}/LICENSE`
}

async function scanNodeZip(archivePath, release, tuple, limits, { destination, signal } = {}) {
  const root = archiveRoot(release, tuple)
  const state = {
    root,
    hasNodeExecutable: false,
    hasLicense: false,
    largestFileBytes: 0
  }
  const result = await visitSshRelayZip(
    archivePath,
    limits,
    async (entry, consume) => {
      if (entry.path !== root && !entry.path.startsWith(`${root}/`)) {
        throw new Error('Node ZIP entry is outside its exact versioned root')
      }
      if (entry.type === 'file') {
        state.largestFileBytes = Math.max(state.largestFileBytes, entry.size)
        state.hasNodeExecutable ||= entry.path === `${root}/node.exe`
        state.hasLicense ||= entry.path === `${root}/LICENSE`
        const relativePath = entry.path.slice(root.length + 1)
        const outputPath =
          destination && selectedBuildInput(root, entry.path)
            ? join(destination, root, ...relativePath.split('/'))
            : undefined
        await consume({ outputPath, mode: entry.path === `${root}/node.exe` ? 0o755 : 0o644 })
      }
    },
    { signal }
  )
  if (!state.hasNodeExecutable || !state.hasLicense) {
    throw new Error('Node ZIP is missing node.exe or its license')
  }
  return { ...result, ...state }
}

export async function inspectSshRelayNodeZip(
  archivePath,
  releaseInput,
  tuple,
  overrides = {},
  { signal } = {}
) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  const limits = {
    ...DEFAULT_LIMITS,
    maximumArchiveBytes: Math.min(DEFAULT_LIMITS.maximumArchiveBytes, release.maximumArchiveBytes),
    ...overrides
  }
  return scanNodeZip(archivePath, release, tuple, limits, { signal })
}

export async function extractVerifiedSshRelayNodeZipBuildInputs(
  releaseInput,
  tuple,
  sourceArchivePath,
  destination,
  { headersArchivePath, importLibraryPath, signal } = {}
) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  const effectiveSignal = signal ?? AbortSignal.timeout(ZIP_TIMEOUT_MS)
  await verifySshRelayNodeArchive(release, tuple, sourceArchivePath)
  const stagingDirectory = await mkdtemp(join(tmpdir(), 'orca-node-verified-zip-'))
  const stagedArchivePath = join(stagingDirectory, release.archives[tuple].name)
  try {
    if (!headersArchivePath || !importLibraryPath) {
      throw new Error('Windows Node extraction requires explicit headers and import-library inputs')
    }
    await copyFile(sourceArchivePath, stagedArchivePath, constants.COPYFILE_EXCL)
    await verifySshRelayNodeArchive(release, tuple, stagedArchivePath)
    await mkdir(destination)
    const inspection = await scanNodeZip(stagedArchivePath, release, tuple, DEFAULT_LIMITS, {
      destination,
      signal: effectiveSignal
    })
    const extractedRoot = join(destination, inspection.root)
    const nodePath = join(extractedRoot, 'node.exe')
    const headers = await extractVerifiedSshRelayNodeHeaders(
      release,
      headersArchivePath,
      extractedRoot,
      {
        signal: effectiveSignal
      }
    )
    await verifySshRelayNodeWindowsBuildInput(release, 'import-library', tuple, importLibraryPath)
    const releaseDirectory = join(extractedRoot, 'Release')
    await mkdir(releaseDirectory)
    const stagedLibraryPath = join(releaseDirectory, 'node.lib')
    await copyFile(importLibraryPath, stagedLibraryPath, constants.COPYFILE_EXCL)
    await verifySshRelayNodeWindowsBuildInput(release, 'import-library', tuple, stagedLibraryPath)
    const [nodeMetadata, licenseMetadata, headerMetadata] = await Promise.all([
      stat(nodePath),
      stat(join(extractedRoot, 'LICENSE')),
      stat(join(extractedRoot, 'include', 'node', 'node.h'))
    ])
    if (!nodeMetadata.isFile() || !licenseMetadata.isFile() || !headerMetadata.isFile()) {
      throw new Error('Extracted Node ZIP build inputs do not match the inspected archive contract')
    }
    return { ...inspection, headers, extractedRoot, nodePath }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

export { DEFAULT_LIMITS }
