import { constants } from 'node:fs'
import { createReadStream } from 'node:fs'
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { Parser, Unpack } from 'tar'

import { verifySshRelayNodeWindowsBuildInput } from './ssh-relay-node-release-file-verification.mjs'
import { validateSshRelayNodeReleaseContract } from './ssh-relay-node-release-contract.mjs'

const MAX_ENTRIES = 100_000
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_PATH_BYTES = 512
const MAX_DEPTH = 32
const GZIP_TIMEOUT_MS = 5 * 60 * 1000
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function assertPortableSshRelayNodeHeaderPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error('Node headers entry is not a bounded portable relative path')
  }
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) {
      throw new Error('Node headers entry contains a control character')
    }
  }
  const path = value.endsWith('/') ? value.slice(0, -1) : value
  const segments = path.split('/')
  if (
    segments.length > MAX_DEPTH ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_DEVICE_NAME.test(segment)
    )
  ) {
    throw new Error('Node headers entry contains an unsafe path segment')
  }
  return path
}

function createState(root) {
  return {
    root,
    seen: new Set(),
    foldedPaths: new Set(),
    entries: 0,
    files: 0,
    expandedBytes: 0,
    hasNodeHeader: false,
    hasCommonGypi: false,
    hasConfigGypi: false
  }
}

function inspectEntry(entry, state) {
  const path = assertPortableSshRelayNodeHeaderPath(entry.path)
  if (path !== state.root && !path.startsWith(`${state.root}/`)) {
    throw new Error('Node headers entry is outside its exact versioned root')
  }
  if (state.seen.has(path)) {
    throw new Error(`Node headers archive contains a duplicate entry: ${path}`)
  }
  const foldedPath = path.toLowerCase()
  if (state.foldedPaths.has(foldedPath)) {
    throw new Error(`Node headers archive contains a case-fold collision: ${path}`)
  }
  state.seen.add(path)
  state.foldedPaths.add(foldedPath)
  state.entries += 1
  if (state.entries > MAX_ENTRIES) {
    throw new Error('Node headers archive exceeds the entry-count limit')
  }
  if (entry.type !== 'File' && entry.type !== 'Directory') {
    throw new Error(`Node headers archive contains a prohibited entry type: ${entry.type}`)
  }
  if (entry.type === 'File') {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
      throw new Error('Node headers archive file exceeds the per-file size limit')
    }
    state.files += 1
    state.expandedBytes += entry.size
    if (state.expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error('Node headers archive exceeds the expanded-size limit')
    }
  }
  state.hasNodeHeader ||= path === `${state.root}/include/node/node.h` && entry.type === 'File'
  state.hasCommonGypi ||= path === `${state.root}/include/node/common.gypi` && entry.type === 'File'
  state.hasConfigGypi ||= path === `${state.root}/include/node/config.gypi` && entry.type === 'File'
}

function result(state) {
  if (!state.hasNodeHeader || !state.hasCommonGypi || !state.hasConfigGypi) {
    throw new Error('Node headers archive is missing required node-gyp inputs')
  }
  return {
    root: state.root,
    entries: state.entries,
    files: state.files,
    expandedBytes: state.expandedBytes
  }
}

async function pipeGzip(archivePath, destination, signal) {
  await pipeline(createReadStream(archivePath), createGunzip(), destination, { signal })
}

async function inspectArchive(archivePath, root, signal) {
  const state = createState(root)
  const parser = new Parser({ strict: true })
  parser.on('entry', (entry) => {
    try {
      inspectEntry(entry, state)
      entry.resume()
    } catch (error) {
      parser.abort(error)
    }
  })
  await pipeGzip(archivePath, parser, signal)
  return result(state)
}

export async function extractVerifiedSshRelayNodeHeaders(
  releaseInput,
  archivePath,
  nodeRoot,
  { signal } = {}
) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  const effectiveSignal = signal ?? AbortSignal.timeout(GZIP_TIMEOUT_MS)
  await verifySshRelayNodeWindowsBuildInput(release, 'headers', undefined, archivePath)
  const stagingDirectory = await mkdtemp(join(tmpdir(), 'orca-node-verified-headers-'))
  const stagedArchivePath = join(stagingDirectory, release.windowsBuildInputs.headersArchive.name)
  const root = `node-v${release.nodeVersion}`
  try {
    await copyFile(archivePath, stagedArchivePath, constants.COPYFILE_EXCL)
    await verifySshRelayNodeWindowsBuildInput(release, 'headers', undefined, stagedArchivePath)
    const inspection = await inspectArchive(stagedArchivePath, root, effectiveSignal)
    const unpack = new Unpack({
      cwd: nodeRoot,
      strict: true,
      preservePaths: false,
      strip: 1,
      filter: (path, entry) =>
        (entry.type === 'File' || entry.type === 'Directory') &&
        (path === `${root}/include` || path.startsWith(`${root}/include/`))
    })
    await pipeGzip(stagedArchivePath, unpack, effectiveSignal)
    if (!(await stat(join(nodeRoot, 'include', 'node', 'node.h'))).isFile()) {
      throw new Error('Extracted Node headers do not contain include/node/node.h')
    }
    return inspection
  } catch (error) {
    await rm(join(nodeRoot, 'include'), { recursive: true, force: true })
    throw error
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}
