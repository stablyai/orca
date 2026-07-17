import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { assertSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { verifySshRelayRuntimeNativeSigningReturn } from './ssh-relay-runtime-native-signing-payload.mjs'
import { assertSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'
import { verifyRuntimeTree } from './verify-ssh-relay-runtime.mjs'

function containsPath(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function physicalDirectory(path, label) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Runtime native signing ${label} must be a real directory`)
  }
  return realpath(path)
}

async function assertAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error('Runtime native signing apply requires an exclusive output root')
}

export async function assertSshRelayRuntimeNativeSigningApplyRoots({
  sourceRuntimeRoot,
  returnedRoot,
  outputRuntimeRoot
}) {
  const absoluteOutput = resolve(outputRuntimeRoot)
  const [physicalSource, physicalReturned, physicalOutputParent] = await Promise.all([
    physicalDirectory(resolve(sourceRuntimeRoot), 'source root'),
    physicalDirectory(resolve(returnedRoot), 'returned root'),
    physicalDirectory(dirname(absoluteOutput), 'output parent')
  ])
  const physicalOutput = resolve(physicalOutputParent, basename(absoluteOutput))
  const roots = [physicalSource, physicalReturned, physicalOutput]
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (containsPath(roots[left], roots[right]) || containsPath(roots[right], roots[left])) {
        throw new Error('Runtime native signing apply roots must be physically disjoint')
      }
    }
  }
  await assertAbsent(physicalOutput)
  return { physicalSource, physicalReturned, physicalOutput }
}

function localPath(root, portablePath) {
  return resolve(root, ...portablePath.split('/'))
}

function finalIdentity(identity, returnedFiles) {
  const returned = new Map(returnedFiles.map((entry) => [entry.path, entry]))
  const entries = identity.entries.map((entry) => {
    const signed = returned.get(entry.path)
    return signed
      ? { ...entry, size: signed.signedSize, sha256: signed.signedSha256 }
      : { ...entry }
  })
  const files = entries.filter((entry) => entry.type === 'file')
  const {
    archive: _archive,
    contentId: _contentId,
    expandedSize: _size,
    fileCount: _count,
    ...base
  } = identity
  const candidate = {
    ...base,
    entries,
    fileCount: files.length,
    expandedSize: files.reduce((total, entry) => total + entry.size, 0)
  }
  return { ...candidate, contentId: computeSshRelayRuntimeContentId(candidate) }
}

async function copyRuntimeTree({
  identity,
  returnedFiles,
  physicalSource,
  physicalReturned,
  physicalOutput,
  copyFileImpl
}) {
  const returnedPaths = new Set(returnedFiles.map((entry) => entry.path))
  const directories = identity.entries
    .filter((entry) => entry.type === 'directory')
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length)
  for (const entry of directories) {
    const destination = localPath(physicalOutput, entry.path)
    await mkdir(destination, { mode: entry.mode })
    if (process.platform !== 'win32') {
      await chmod(destination, entry.mode)
    }
  }
  for (const entry of identity.entries.filter((candidate) => candidate.type === 'file')) {
    const sourceRoot = returnedPaths.has(entry.path) ? physicalReturned : physicalSource
    const destination = localPath(physicalOutput, entry.path)
    await copyFileImpl(localPath(sourceRoot, entry.path), destination, constants.COPYFILE_EXCL)
    if (process.platform !== 'win32') {
      await chmod(destination, entry.mode)
    }
  }
}

export async function applySshRelayRuntimeNativeSigningReturn({
  sourceRuntimeRoot,
  returnedRoot,
  outputRuntimeRoot,
  identity,
  selection,
  copyFileImpl = copyFile
}) {
  assertSshRelayRuntimeClosureEntries(identity)
  assertSshRelayRuntimeNativeSigningSelection(identity, selection)
  if (selection.signingFiles.length === 0) {
    throw new Error('Runtime native signing apply selection has no signing files')
  }
  const roots = await assertSshRelayRuntimeNativeSigningApplyRoots({
    sourceRuntimeRoot,
    returnedRoot,
    outputRuntimeRoot
  })
  await verifyRuntimeTree(roots.physicalSource, identity)
  const returned = await verifySshRelayRuntimeNativeSigningReturn({
    returnedRoot: roots.physicalReturned,
    selection
  })
  const candidateIdentity = finalIdentity(identity, returned.returnedFiles)
  if (candidateIdentity.contentId === identity.contentId) {
    throw new Error('Runtime native signing apply did not change content identity')
  }
  assertSshRelayRuntimeClosureEntries(candidateIdentity)

  let outputCreated = false
  try {
    await mkdir(roots.physicalOutput)
    outputCreated = true
    await copyRuntimeTree({
      identity,
      returnedFiles: returned.returnedFiles,
      ...roots,
      copyFileImpl
    })
    await verifyRuntimeTree(roots.physicalOutput, candidateIdentity)
    return {
      tupleId: identity.tupleId,
      sourceContentId: identity.contentId,
      finalContentId: candidateIdentity.contentId,
      returnedFiles: returned.returnedFiles,
      identity: candidateIdentity
    }
  } catch (error) {
    if (outputCreated) {
      // Why: an incomplete post-sign tree must never survive as a launchable or archivable candidate.
      await rm(roots.physicalOutput, { recursive: true, force: true })
    }
    throw error
  }
}
