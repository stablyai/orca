import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

export const MAX_SIGNED_FILE_GROWTH_BYTES = 4 * 1024 * 1024
export const MAX_RETURNED_PAYLOAD_BYTES = 64 * 1024 * 1024

function localPath(root, portablePath) {
  if (
    typeof portablePath !== 'string' ||
    portablePath.length === 0 ||
    portablePath.includes('\\') ||
    portablePath.startsWith('/') ||
    portablePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Runtime native signing rejects non-portable path: ${portablePath}`)
  }
  return resolve(root, ...portablePath.split('/'))
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return `sha256:${hash.digest('hex')}`
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    throw new Error(`Runtime native signing ${label} is a symbolic link: ${path}`)
  }
  if (!metadata.isFile()) {
    throw new Error(`Runtime native signing ${label} is not a regular file: ${path}`)
  }
  return metadata
}

async function verifySourceFile(runtimeRoot, entry) {
  const path = localPath(runtimeRoot, entry.path)
  const metadata = await assertRegularFile(path, 'source')
  if (metadata.size !== entry.sourceSize) {
    throw new Error(`Runtime native signing source has wrong authenticated size: ${entry.path}`)
  }
  if ((await sha256File(path)) !== entry.sourceSha256) {
    throw new Error(`Runtime native signing source has wrong authenticated hash: ${entry.path}`)
  }
}

function assertExclusiveStageLocation(runtimeRoot, stagingRoot) {
  const relativeStage = relative(runtimeRoot, stagingRoot)
  if (relativeStage === '' || (!relativeStage.startsWith('..') && !isAbsolute(relativeStage))) {
    throw new Error('Runtime native signing staging root must be outside the runtime')
  }
}

async function resolveSigningRoots(runtimeRoot, stagingRoot) {
  const runtimeMetadata = await lstat(runtimeRoot)
  if (runtimeMetadata.isSymbolicLink() || !runtimeMetadata.isDirectory()) {
    throw new Error('Runtime native signing source root must be a real directory')
  }
  const physicalRuntimeRoot = await realpath(runtimeRoot)
  const physicalStagingParent = await realpath(dirname(stagingRoot))
  const physicalStagingRoot = resolve(physicalStagingParent, basename(stagingRoot))
  assertExclusiveStageLocation(physicalRuntimeRoot, physicalStagingRoot)
  return { physicalRuntimeRoot, physicalStagingRoot }
}

async function assertPathAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error('Runtime native signing requires an exclusive staging root')
}

async function copySigningFile(runtimeRoot, stagingRoot, entry) {
  const source = localPath(runtimeRoot, entry.path)
  const destination = localPath(stagingRoot, entry.path)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  const metadata = await assertRegularFile(destination, 'staged file')
  if (
    metadata.size !== entry.sourceSize ||
    (await sha256File(destination)) !== entry.sourceSha256
  ) {
    throw new Error(`Runtime native signing staged bytes changed during copy: ${entry.path}`)
  }
  return { path: entry.path, sourceSha256: entry.sourceSha256, sourceSize: entry.sourceSize }
}

export async function stageSshRelayRuntimeNativeSigningPayload({
  runtimeRoot,
  stagingRoot,
  selection
}) {
  const absoluteRuntimeRoot = resolve(runtimeRoot)
  const absoluteStagingRoot = resolve(stagingRoot)
  const { physicalRuntimeRoot, physicalStagingRoot } = await resolveSigningRoots(
    absoluteRuntimeRoot,
    absoluteStagingRoot
  )
  await assertPathAbsent(physicalStagingRoot)
  await Promise.all(
    selection.verificationFiles.map((entry) => verifySourceFile(physicalRuntimeRoot, entry))
  )
  if (selection.signingFiles.length === 0) {
    return { tupleId: selection.tupleId, stagingRequired: false, stagedFiles: [], stagedSize: 0 }
  }

  await mkdir(physicalStagingRoot)
  try {
    const stagedFiles = []
    for (const entry of selection.signingFiles) {
      stagedFiles.push(await copySigningFile(physicalRuntimeRoot, physicalStagingRoot, entry))
    }
    return {
      tupleId: selection.tupleId,
      stagingRequired: true,
      stagedFiles,
      stagedSize: stagedFiles.reduce((total, entry) => total + entry.sourceSize, 0)
    }
  } catch (error) {
    // Why: a partial signing payload must never be mistaken for a complete retryable input.
    await rm(physicalStagingRoot, { recursive: true, force: true })
    throw error
  }
}

function expectedDirectories(files) {
  const directories = new Set()
  for (const file of files) {
    const segments = file.path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'))
    }
  }
  return directories
}

async function walkReturnedTree(
  root,
  segments = [],
  result = { directories: new Set(), files: new Map() }
) {
  for (const directoryEntry of await readdir(root, { withFileTypes: true })) {
    const childSegments = [...segments, directoryEntry.name]
    const portablePath = childSegments.join('/')
    const path = resolve(root, directoryEntry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Runtime native signing returned tree contains a symbolic link: ${portablePath}`
      )
    }
    if (metadata.isDirectory()) {
      result.directories.add(portablePath)
      await walkReturnedTree(path, childSegments, result)
    } else if (metadata.isFile()) {
      result.files.set(portablePath, { path, metadata })
    } else {
      throw new Error(
        `Runtime native signing returned tree contains a special entry: ${portablePath}`
      )
    }
  }
  return result
}

function assertExactReturnedClosure(actual, expectedFiles) {
  const expectedFilePaths = new Set(expectedFiles.map((entry) => entry.path))
  for (const entry of expectedFiles) {
    if (!actual.files.has(entry.path)) {
      throw new Error(`Runtime native signing is missing returned file: ${entry.path}`)
    }
  }
  for (const path of actual.files.keys()) {
    if (!expectedFilePaths.has(path)) {
      throw new Error(`Runtime native signing has unexpected returned file: ${path}`)
    }
  }
  const directories = expectedDirectories(expectedFiles)
  for (const path of actual.directories) {
    if (!directories.has(path)) {
      throw new Error(`Runtime native signing has unexpected returned directory: ${path}`)
    }
  }
  for (const path of directories) {
    if (!actual.directories.has(path)) {
      throw new Error(`Runtime native signing is missing returned directory: ${path}`)
    }
  }
}

export async function verifySshRelayRuntimeNativeSigningInput({ stagingRoot, selection }) {
  if (selection.signingFiles.length === 0) {
    throw new Error('Runtime native signing selection has no input payload')
  }
  const absoluteStagingRoot = resolve(stagingRoot)
  const rootMetadata = await lstat(absoluteStagingRoot)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Runtime native signing input root must be a real directory')
  }
  const actual = await walkReturnedTree(absoluteStagingRoot)
  assertExactReturnedClosure(actual, selection.signingFiles)
  let stagedSize = 0
  const stagedFiles = []
  for (const entry of selection.signingFiles) {
    const staged = actual.files.get(entry.path)
    if (
      staged.metadata.size !== entry.sourceSize ||
      (await sha256File(staged.path)) !== entry.sourceSha256
    ) {
      throw new Error(`Runtime native signing input changed after staging: ${entry.path}`)
    }
    stagedSize += staged.metadata.size
    if (stagedSize > MAX_RETURNED_PAYLOAD_BYTES) {
      throw new Error('Runtime native signing input exceeds total size bound')
    }
    stagedFiles.push({
      path: entry.path,
      sourceSha256: entry.sourceSha256,
      sourceSize: entry.sourceSize
    })
  }
  return { tupleId: selection.tupleId, stagedFiles, stagedSize }
}

export async function verifySshRelayRuntimeNativeSigningReturn({ returnedRoot, selection }) {
  if (selection.signingFiles.length === 0) {
    throw new Error('Runtime native signing selection has no returned payload')
  }
  const absoluteReturnedRoot = resolve(returnedRoot)
  const rootMetadata = await lstat(absoluteReturnedRoot)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Runtime native signing returned root must be a real directory')
  }
  const actual = await walkReturnedTree(absoluteReturnedRoot)
  assertExactReturnedClosure(actual, selection.signingFiles)

  let returnedSize = 0
  const returnedFiles = []
  for (const entry of selection.signingFiles) {
    const returned = actual.files.get(entry.path)
    if (
      returned.metadata.size <= 0 ||
      returned.metadata.size > entry.sourceSize + MAX_SIGNED_FILE_GROWTH_BYTES
    ) {
      throw new Error(`Runtime native signing returned file exceeds size bound: ${entry.path}`)
    }
    returnedSize += returned.metadata.size
    if (returnedSize > MAX_RETURNED_PAYLOAD_BYTES) {
      throw new Error('Runtime native signing returned payload exceeds total size bound')
    }
    const signedSha256 = await sha256File(returned.path)
    if (signedSha256 === entry.sourceSha256) {
      throw new Error(`Runtime native signing returned file did not change: ${entry.path}`)
    }
    returnedFiles.push({
      path: entry.path,
      role: entry.role,
      sourceSha256: entry.sourceSha256,
      signedSha256,
      signedSize: returned.metadata.size
    })
  }
  return { tupleId: selection.tupleId, returnedFiles, returnedSize }
}
