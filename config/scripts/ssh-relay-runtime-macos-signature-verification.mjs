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
import { verifyRuntimeTree } from './verify-ssh-relay-runtime.mjs'

const CODESIGN_PATH = '/usr/bin/codesign'
const CODESIGN_TIMEOUT_MS = 30_000
const CODESIGN_OUTPUT_BYTES = 64 * 1024
const NODE_TEAM_IDENTIFIER = 'HX7739G8FX'
const NODE_AUTHORITY = `Developer ID Application: Node.js Foundation (${NODE_TEAM_IDENTIFIER})`
const APPLE_CHAIN = ['Developer ID Certification Authority', 'Apple Root CA']
const TEAM_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/

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

function outputBytes(result) {
  return Buffer.byteLength(result?.stdout ?? '') + Buffer.byteLength(result?.stderr ?? '')
}

function runCodesign(path, args, spawnSyncImpl) {
  const result = spawnSyncImpl(CODESIGN_PATH, [...args, path], {
    encoding: 'utf8',
    maxBuffer: CODESIGN_OUTPUT_BYTES,
    timeout: CODESIGN_TIMEOUT_MS,
    windowsHide: true
  })
  if (result?.error) {
    throw new Error(`Runtime macOS codesign probe failed: ${result.error.message}`)
  }
  if (outputBytes(result) > CODESIGN_OUTPUT_BYTES) {
    throw new Error('Runtime macOS codesign probe exceeded its output bound')
  }
  if (result?.status !== 0) {
    throw new Error(
      `Runtime macOS codesign probe failed with exit code ${result?.status ?? '<unknown>'}`
    )
  }
  return result
}

export function parseSshRelayRuntimeMacosCodeSignature(stderr) {
  if (typeof stderr !== 'string' || stderr.trim() === '') {
    throw new Error('Runtime macOS codesign display output is empty')
  }
  const fields = new Map()
  const authorities = []
  for (const line of stderr.split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (key === 'Authority') {
      authorities.push(value)
    } else if (fields.has(key)) {
      throw new Error(`Runtime macOS codesign display repeats field: ${key}`)
    } else {
      fields.set(key, value)
    }
  }
  if (
    authorities.length !== 3 ||
    new Set(authorities).size !== authorities.length ||
    !isDeepStrictEqual(authorities.slice(1), APPLE_CHAIN)
  ) {
    throw new Error('Runtime macOS codesign has an unexpected Developer ID authority chain')
  }
  const teamIdentifier = fields.get('TeamIdentifier')
  const format = fields.get('Format')
  if (
    fields.get('Signature') === 'adhoc' ||
    !TEAM_IDENTIFIER_PATTERN.test(teamIdentifier ?? '') ||
    typeof format !== 'string' ||
    !format.startsWith('Mach-O')
  ) {
    throw new Error('Runtime macOS codesign is not a Developer ID signature')
  }
  return {
    authority: authorities[0],
    authorities,
    format,
    teamIdentifier
  }
}

function assertSignerPolicy(signature, signerKind, expectedOrcaTeamIdentifier) {
  if (signerKind === 'official-node') {
    if (
      signature.teamIdentifier !== NODE_TEAM_IDENTIFIER ||
      signature.authority !== NODE_AUTHORITY
    ) {
      throw new Error('Runtime macOS signature violates official Node signer policy')
    }
    return
  }
  const expectedAuthoritySuffix = ` (${expectedOrcaTeamIdentifier})`
  if (
    signature.teamIdentifier !== expectedOrcaTeamIdentifier ||
    !signature.authority.startsWith('Developer ID Application: ') ||
    !signature.authority.endsWith(expectedAuthoritySuffix)
  ) {
    throw new Error('Runtime macOS signature violates Orca signer policy')
  }
}

function assertIdentityTransition(sourceIdentity, finalIdentity, selection) {
  assertSshRelayRuntimeClosureEntries(finalIdentity)
  if (
    computeSshRelayRuntimeContentId(sourceIdentity) !== sourceIdentity.contentId ||
    Object.hasOwn(finalIdentity, 'archive') ||
    finalIdentity.tupleId !== sourceIdentity.tupleId ||
    finalIdentity.os !== 'darwin' ||
    finalIdentity.contentId === sourceIdentity.contentId
  ) {
    throw new Error('Runtime macOS final identity does not match its unsigned source')
  }
  const signingPaths = new Set(selection.signingFiles.map((entry) => entry.path))
  const finalEntries = new Map(finalIdentity.entries.map((entry) => [entry.path, entry]))
  let returnedSize = 0
  for (const sourceEntry of sourceIdentity.entries) {
    const finalEntry = finalEntries.get(sourceEntry.path)
    if (!finalEntry) {
      throw new Error(`Runtime macOS final identity is missing entry: ${sourceEntry.path}`)
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
        throw new Error(`Runtime macOS signed identity transition is invalid: ${sourceEntry.path}`)
      }
      returnedSize += finalEntry.size
    } else if (!isDeepStrictEqual(finalEntry, sourceEntry)) {
      throw new Error(`Runtime macOS unsigned identity entry changed: ${sourceEntry.path}`)
    }
    finalEntries.delete(sourceEntry.path)
  }
  if (finalEntries.size !== 0) {
    throw new Error(
      `Runtime macOS final identity has an extra entry: ${finalEntries.keys().next().value}`
    )
  }
  if (returnedSize > MAX_RETURNED_PAYLOAD_BYTES) {
    throw new Error('Runtime macOS signed identity exceeds the returned payload size bound')
  }
  const files = finalIdentity.entries.filter((entry) => entry.type === 'file')
  const expandedSize = files.reduce((total, entry) => total + entry.size, 0)
  if (finalIdentity.fileCount !== files.length || finalIdentity.expandedSize !== expandedSize) {
    throw new Error('Runtime macOS final identity totals are inconsistent')
  }
}

async function verifySignedFile({
  path,
  entry,
  signerKind,
  expectedOrcaTeamIdentifier,
  spawnSyncImpl
}) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Runtime macOS signature target is not a regular file: ${entry.path}`)
  }
  if ((await sha256File(path)) !== entry.sha256) {
    throw new Error(`Runtime macOS signature target has wrong authenticated hash: ${entry.path}`)
  }
  runCodesign(path, ['--verify', '--strict', '--verbose=4'], spawnSyncImpl)
  const display = runCodesign(path, ['--display', '--verbose=4'], spawnSyncImpl)
  const signature = parseSshRelayRuntimeMacosCodeSignature(display.stderr)
  assertSignerPolicy(signature, signerKind, expectedOrcaTeamIdentifier)
  if ((await sha256File(path)) !== entry.sha256) {
    throw new Error(`Runtime macOS file changed during signature verification: ${entry.path}`)
  }
  return {
    path: entry.path,
    role: entry.role,
    sha256: entry.sha256,
    signerKind,
    authority: signature.authority,
    teamIdentifier: signature.teamIdentifier
  }
}

export async function verifySshRelayRuntimeMacosSignatures({
  runtimeRoot,
  sourceIdentity,
  finalIdentity,
  selection,
  expectedOrcaTeamIdentifier,
  platform = process.platform,
  spawnSyncImpl = spawnSync
}) {
  if (platform !== 'darwin') {
    throw new Error('Runtime macOS signature verification requires macOS')
  }
  if (!TEAM_IDENTIFIER_PATTERN.test(expectedOrcaTeamIdentifier ?? '')) {
    throw new Error('Runtime macOS signature verification requires an exact Orca team identifier')
  }
  assertSshRelayRuntimeNativeSigningSelection(sourceIdentity, selection)
  assertIdentityTransition(sourceIdentity, finalIdentity, selection)
  const rootMetadata = await lstat(resolve(runtimeRoot))
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Runtime macOS signature verification requires a real runtime root')
  }
  const physicalRoot = await realpath(resolve(runtimeRoot))
  // Why: native code is probed only after every byte in the final runtime matches its new identity.
  await verifyRuntimeTree(physicalRoot, finalIdentity)

  const finalFiles = new Map(
    finalIdentity.entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => [entry.path, entry])
  )
  const targets = [
    ...selection.immutableVendorFiles.map((entry) => ({
      entry: finalFiles.get(entry.path),
      signerKind: 'official-node'
    })),
    ...selection.signingFiles.map((entry) => ({
      entry: finalFiles.get(entry.path),
      signerKind: 'orca-built'
    }))
  ]
  const verifiedFiles = []
  for (const target of targets) {
    if (!target.entry) {
      throw new Error('Runtime macOS signature target is missing from the final identity')
    }
    verifiedFiles.push(
      await verifySignedFile({
        path: localPath(physicalRoot, target.entry.path),
        entry: target.entry,
        signerKind: target.signerKind,
        expectedOrcaTeamIdentifier,
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
