import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { assertSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import {
  MAX_RETURNED_PAYLOAD_BYTES,
  MAX_SIGNED_FILE_GROWTH_BYTES
} from './ssh-relay-runtime-native-signing-payload.mjs'
import { assertSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'
import {
  classifySshRelayRuntimeWindowsAuthenticode,
  getSshRelayRuntimeWindowsAuthenticodeJson,
  parseSshRelayRuntimeWindowsAuthenticodeJson
} from './ssh-relay-runtime-windows-authenticode-assessment.mjs'
import { verifyRuntimeTree } from './verify-ssh-relay-runtime.mjs'

export const OFFICIAL_NODE_WINDOWS_SIGNER_SUBJECT =
  'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
export const ORCA_WINDOWS_SIGNER_SUBJECT =
  'CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US'

function localPath(root, portablePath) {
  return resolve(root, ...portablePath.split('/'))
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return `sha256:${hash.digest('hex')}`
}

function assertIdentityTransition(sourceIdentity, finalIdentity, selection) {
  assertSshRelayRuntimeClosureEntries(finalIdentity)
  if (
    computeSshRelayRuntimeContentId(sourceIdentity) !== sourceIdentity.contentId ||
    computeSshRelayRuntimeContentId(finalIdentity) !== finalIdentity.contentId ||
    Object.hasOwn(finalIdentity, 'archive') ||
    finalIdentity.tupleId !== sourceIdentity.tupleId ||
    finalIdentity.os !== 'win32' ||
    finalIdentity.contentId === sourceIdentity.contentId
  ) {
    throw new Error('Runtime Windows final identity does not match its unsigned source')
  }
  const signingPaths = new Set(selection.signingFiles.map((entry) => entry.path))
  const finalEntries = new Map(finalIdentity.entries.map((entry) => [entry.path, entry]))
  let returnedSize = 0
  for (const sourceEntry of sourceIdentity.entries) {
    const finalEntry = finalEntries.get(sourceEntry.path)
    if (!finalEntry) {
      throw new Error(`Runtime Windows final identity is missing entry: ${sourceEntry.path}`)
    }
    if (signingPaths.has(sourceEntry.path)) {
      if (
        sourceEntry.type !== 'file' ||
        finalEntry.type !== 'file' ||
        finalEntry.sha256 === sourceEntry.sha256 ||
        finalEntry.size <= 0 ||
        finalEntry.size > sourceEntry.size + MAX_SIGNED_FILE_GROWTH_BYTES ||
        finalEntry.path !== sourceEntry.path ||
        finalEntry.role !== sourceEntry.role ||
        finalEntry.mode !== sourceEntry.mode
      ) {
        throw new Error(
          `Runtime Windows signed identity transition is invalid: ${sourceEntry.path}`
        )
      }
      returnedSize += finalEntry.size
    } else if (!isDeepStrictEqual(finalEntry, sourceEntry)) {
      throw new Error(`Runtime Windows unsigned identity entry changed: ${sourceEntry.path}`)
    }
    finalEntries.delete(sourceEntry.path)
  }
  if (finalEntries.size !== 0) {
    throw new Error(
      `Runtime Windows final identity has an extra entry: ${finalEntries.keys().next().value}`
    )
  }
  if (returnedSize > MAX_RETURNED_PAYLOAD_BYTES) {
    throw new Error('Runtime Windows signed identity exceeds the returned payload size bound')
  }
  const files = finalIdentity.entries.filter((entry) => entry.type === 'file')
  const expandedSize = files.reduce((total, entry) => total + entry.size, 0)
  if (finalIdentity.fileCount !== files.length || finalIdentity.expandedSize !== expandedSize) {
    throw new Error('Runtime Windows final identity totals are inconsistent')
  }
}

function assertSignerPolicy(signature, signerKind, expectedSigner) {
  if (signature.status !== 'Valid') {
    throw new Error('Runtime Windows requires a valid Authenticode signature on every native file')
  }
  const classified = classifySshRelayRuntimeWindowsAuthenticode(signature)
  if (signerKind === 'official-node') {
    if (classified.signerSubject !== OFFICIAL_NODE_WINDOWS_SIGNER_SUBJECT) {
      throw new Error('Runtime Windows signature violates official Node signer policy')
    }
  } else if (signerKind === 'orca-built') {
    if (classified.signerSubject !== ORCA_WINDOWS_SIGNER_SUBJECT) {
      throw new Error('Runtime Windows signature violates Orca signer policy')
    }
  } else if (
    classified.signerSubject !== expectedSigner.signerSubject ||
    classified.signerThumbprint !== expectedSigner.signerThumbprint
  ) {
    throw new Error('Runtime Windows signature violates preserved upstream signer policy')
  }
  return classified
}

export async function verifySshRelayRuntimeWindowsSignatureTarget({
  path,
  entry,
  signerKind,
  expectedSigner,
  spawnSyncImpl = spawnSync
}) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Runtime Windows signature target is not a regular file: ${entry.path}`)
  }
  if ((await sha256File(path)) !== entry.sha256) {
    throw new Error(`Runtime Windows signature target has wrong authenticated hash: ${entry.path}`)
  }
  const signature = parseSshRelayRuntimeWindowsAuthenticodeJson(
    getSshRelayRuntimeWindowsAuthenticodeJson(path, spawnSyncImpl)
  )
  const classified = assertSignerPolicy(signature, signerKind, expectedSigner)
  if ((await sha256File(path)) !== entry.sha256) {
    throw new Error(`Runtime Windows file changed during signature verification: ${entry.path}`)
  }
  return {
    path: entry.path,
    role: entry.role,
    sha256: entry.sha256,
    signerKind,
    signerSubject: classified.signerSubject,
    signerThumbprint: classified.signerThumbprint
  }
}

function verificationTargets(finalIdentity, selection) {
  const finalFiles = new Map(
    finalIdentity.entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => [entry.path, entry])
  )
  const node = new Map(selection.immutableVendorFiles.map((entry) => [entry.path, entry]))
  const signing = new Map(selection.signingFiles.map((entry) => [entry.path, entry]))
  const preserved = new Map(selection.preservedUpstreamFiles.map((entry) => [entry.path, entry]))
  return selection.verificationFiles.map((verification) => {
    const entry = finalFiles.get(verification.path)
    if (!entry) {
      throw new Error('Runtime Windows signature target is missing from the final identity')
    }
    if (node.has(entry.path)) {
      return { entry, signerKind: 'official-node' }
    }
    if (signing.has(entry.path)) {
      return { entry, signerKind: 'orca-built' }
    }
    const expectedSigner = preserved.get(entry.path)
    if (!expectedSigner) {
      throw new Error(`Runtime Windows signature target has no signer policy: ${entry.path}`)
    }
    return { entry, signerKind: 'preserved-upstream', expectedSigner }
  })
}

export async function verifySshRelayRuntimeWindowsSignatures({
  runtimeRoot,
  sourceIdentity,
  finalIdentity,
  selection,
  platform = process.platform,
  spawnSyncImpl = spawnSync
}) {
  if (platform !== 'win32') {
    throw new Error('Runtime Windows signature verification requires Windows')
  }
  assertSshRelayRuntimeNativeSigningSelection(sourceIdentity, selection)
  assertIdentityTransition(sourceIdentity, finalIdentity, selection)
  const rootMetadata = await lstat(resolve(runtimeRoot))
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Runtime Windows signature verification requires a real runtime root')
  }
  const physicalRoot = await realpath(resolve(runtimeRoot))
  // Why: native code is probed only after every byte in the final runtime matches its new identity.
  await verifyRuntimeTree(physicalRoot, finalIdentity)

  const verifiedFiles = []
  for (const target of verificationTargets(finalIdentity, selection)) {
    verifiedFiles.push(
      await verifySshRelayRuntimeWindowsSignatureTarget({
        path: localPath(physicalRoot, target.entry.path),
        ...target,
        spawnSyncImpl
      })
    )
  }
  return {
    tupleId: finalIdentity.tupleId,
    sourceContentId: sourceIdentity.contentId,
    finalContentId: finalIdentity.contentId,
    verifiedFiles
  }
}
