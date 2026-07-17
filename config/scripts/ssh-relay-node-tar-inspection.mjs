import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { Parser, Unpack } from 'tar'

import { verifySshRelayNodeArchive } from './ssh-relay-node-release-file-verification.mjs'
import { validateSshRelayNodeReleaseContract } from './ssh-relay-node-release-contract.mjs'

const DEFAULT_LIMITS = Object.freeze({
  maximumEntries: 100_000,
  maximumExpandedBytes: 1024 * 1024 * 1024,
  maximumFileBytes: 256 * 1024 * 1024,
  maximumDepth: 32,
  maximumPathBytes: 512
})
const MAX_XZ_DIAGNOSTIC_BYTES = 64 * 1024
const XZ_TIMEOUT_MS = 5 * 60 * 1000
const ALLOWED_TYPES = new Set(['Directory', 'File', 'SymbolicLink'])

function hasControlOrBackslash(value) {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f || character === '\\') {
      return true
    }
  }
  return false
}

function archiveRoot(release, tuple) {
  const name = release.archives[tuple]?.name
  if (typeof name !== 'string' || !name.endsWith('.tar.xz')) {
    throw new Error(`Node tuple ${String(tuple)} does not use a tar.xz archive`)
  }
  return name.slice(0, -'.tar.xz'.length)
}

function portablePath(value, limits, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > limits.maximumPathBytes ||
    hasControlOrBackslash(value) ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`${label} is not a bounded portable relative path`)
  }
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value
  const segments = withoutTrailingSlash.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe path segment`)
  }
  return withoutTrailingSlash
}

function validateSymlink(entryPath, linkPath, root, limits) {
  if (
    typeof linkPath !== 'string' ||
    linkPath.length === 0 ||
    Buffer.byteLength(linkPath) > limits.maximumPathBytes ||
    hasControlOrBackslash(linkPath) ||
    linkPath.startsWith('/') ||
    /^[A-Za-z]:/.test(linkPath) ||
    linkPath.split('/').some((segment) => segment === '' || segment === '.')
  ) {
    throw new Error('Node archive symlink target is not a bounded portable relative path')
  }
  // Why: official Node npm links use `..`; normalization is safe only inside the signed root.
  const resolved = posix.normalize(posix.join(posix.dirname(entryPath), linkPath))
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error('Node archive symlink resolves outside its versioned root')
  }
}

function createInspectionState(root, limits) {
  return {
    root,
    limits,
    seen: new Set(),
    entries: 0,
    files: 0,
    directories: 0,
    symlinks: 0,
    expandedBytes: 0,
    largestFileBytes: 0,
    nodeMode: null,
    hasLicense: false,
    hasNodeHeader: false
  }
}

function inspectEntry(entry, state) {
  const entryPath = portablePath(entry.path, state.limits, 'Node archive entry path')
  if (entryPath !== state.root && !entryPath.startsWith(`${state.root}/`)) {
    throw new Error('Node archive entry is outside its exact versioned root')
  }
  if (entryPath.split('/').length > state.limits.maximumDepth) {
    throw new Error('Node archive entry exceeds the nesting-depth limit')
  }
  if (state.seen.has(entryPath)) {
    throw new Error(`Node archive contains a duplicate entry: ${entryPath}`)
  }
  state.seen.add(entryPath)
  state.entries += 1
  if (state.entries > state.limits.maximumEntries) {
    throw new Error('Node archive exceeds the entry-count limit')
  }
  if (!ALLOWED_TYPES.has(entry.type)) {
    throw new Error(`Node archive contains prohibited entry type: ${String(entry.type)}`)
  }

  if (entry.type === 'File') {
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > state.limits.maximumFileBytes
    ) {
      throw new Error('Node archive file exceeds the per-file size limit')
    }
    state.files += 1
    state.expandedBytes += entry.size
    state.largestFileBytes = Math.max(state.largestFileBytes, entry.size)
    if (state.expandedBytes > state.limits.maximumExpandedBytes) {
      throw new Error('Node archive exceeds the expanded-size limit')
    }
  } else if (entry.type === 'Directory') {
    state.directories += 1
  } else {
    state.symlinks += 1
    validateSymlink(entryPath, entry.linkpath, state.root, state.limits)
  }

  if (entryPath === `${state.root}/bin/node` && entry.type === 'File') {
    state.nodeMode = entry.mode
  }
  if (entryPath === `${state.root}/LICENSE` && entry.type === 'File') {
    state.hasLicense = true
  }
  if (entryPath === `${state.root}/include/node/node.h` && entry.type === 'File') {
    state.hasNodeHeader = true
  }
}

function inspectionResult(state) {
  if (!Number.isSafeInteger(state.nodeMode) || (state.nodeMode & 0o111) === 0) {
    throw new Error('Node archive is missing an executable bin/node')
  }
  if (!state.hasLicense || !state.hasNodeHeader) {
    throw new Error('Node archive is missing its license or build headers')
  }
  return {
    root: state.root,
    entries: state.entries,
    files: state.files,
    directories: state.directories,
    symlinks: state.symlinks,
    expandedBytes: state.expandedBytes,
    largestFileBytes: state.largestFileBytes,
    nodeMode: state.nodeMode
  }
}

export async function inspectSshRelayNodeTarStream(readable, releaseInput, tuple, overrides = {}) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const state = createInspectionState(archiveRoot(release, tuple), limits)
  const parser = new Parser({ strict: true })
  parser.on('entry', (entry) => {
    try {
      inspectEntry(entry, state)
      entry.resume()
    } catch (error) {
      parser.abort(error)
    }
  })
  await pipeline(readable, parser)
  return inspectionResult(state)
}

async function pipeXzArchive(archivePath, destination, signal) {
  const child = spawn('xz', ['--decompress', '--stdout', '--single-stream', '--', archivePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    signal
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_XZ_DIAGNOSTIC_BYTES)
  })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, closeSignal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`xz failed (${code ?? closeSignal ?? 'unknown'}): ${stderr.trim()}`))
      }
    })
  })
  try {
    await Promise.all([pipeline(child.stdout, destination, { signal }), completion])
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
    }
    await completion.catch(() => {})
    throw error
  }
}

async function inspectXzArchive(archivePath, release, tuple, signal) {
  const state = createInspectionState(archiveRoot(release, tuple), DEFAULT_LIMITS)
  const parser = new Parser({ strict: true })
  parser.on('entry', (entry) => {
    try {
      inspectEntry(entry, state)
      entry.resume()
    } catch (error) {
      parser.abort(error)
    }
  })
  await pipeXzArchive(archivePath, parser, signal)
  return inspectionResult(state)
}

function extractionFilter(root, entryPath, entry) {
  if (entry.type !== 'File' && entry.type !== 'Directory') {
    return false
  }
  return (
    entryPath === root ||
    entryPath === `${root}/bin` ||
    entryPath === `${root}/bin/node` ||
    entryPath === `${root}/LICENSE` ||
    entryPath === `${root}/include` ||
    entryPath === `${root}/include/node` ||
    entryPath.startsWith(`${root}/include/node/`)
  )
}

export async function extractVerifiedSshRelayNodeBuildInputs(
  releaseInput,
  tuple,
  sourceArchivePath,
  destination,
  { signal } = {}
) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  const effectiveSignal = signal ?? AbortSignal.timeout(XZ_TIMEOUT_MS)
  await verifySshRelayNodeArchive(release, tuple, sourceArchivePath)
  const stagingDirectory = await mkdtemp(join(tmpdir(), 'orca-node-verified-archive-'))
  const stagedArchivePath = join(stagingDirectory, release.archives[tuple].name)
  try {
    await copyFile(sourceArchivePath, stagedArchivePath, constants.COPYFILE_EXCL)
    await verifySshRelayNodeArchive(release, tuple, stagedArchivePath)
    const inspection = await inspectXzArchive(stagedArchivePath, release, tuple, effectiveSignal)
    await mkdir(destination)
    const unpack = new Unpack({
      cwd: destination,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) => extractionFilter(inspection.root, entryPath, entry)
    })
    await pipeXzArchive(stagedArchivePath, unpack, effectiveSignal)

    const extractedRoot = join(destination, inspection.root)
    const nodePath = join(extractedRoot, 'bin', 'node')
    const [nodeMetadata, licenseMetadata, headerMetadata] = await Promise.all([
      stat(nodePath),
      stat(join(extractedRoot, 'LICENSE')),
      stat(join(extractedRoot, 'include', 'node', 'node.h'))
    ])
    if (
      !nodeMetadata.isFile() ||
      (nodeMetadata.mode & 0o111) === 0 ||
      !licenseMetadata.isFile() ||
      !headerMetadata.isFile()
    ) {
      throw new Error('Extracted Node build inputs do not match the inspected archive contract')
    }
    return { ...inspection, extractedRoot, nodePath }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

export { DEFAULT_LIMITS }
