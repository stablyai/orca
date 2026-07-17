import { spawnSync } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { readSshRelayRuntimeNativeSigningIdentity } from './ssh-relay-runtime-native-signing-plan.mjs'
import {
  assertSshRelayRuntimeNativeSigningSelection,
  buildSshRelayRuntimeNativeSigningSelection
} from './ssh-relay-runtime-native-signing-selection.mjs'
import { verifySshRelayRuntimeWindowsSignatureTarget } from './ssh-relay-runtime-windows-signature-verification.mjs'
import { verifyRuntimeTree } from './verify-ssh-relay-runtime.mjs'

const MAX_SIGNING_REPORT_BYTES = 4 * 1024 * 1024
const REPORT_FIELDS = [
  'assessments',
  'immutableVendorFiles',
  'payload',
  'platform',
  'policy',
  'preservedUpstreamFiles',
  'signingFiles',
  'tupleId'
]
const ARGUMENT_FIELDS = new Map([
  ['--identity', 'identityPath'],
  ['--runtime-directory', 'runtimeRoot'],
  ['--signing-report', 'signingReportPath']
])

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Runtime Windows source signature ${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`Runtime Windows source signature ${label} has unexpected fields`)
  }
}

export function parseSshRelayRuntimeWindowsSourceSignatureArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = ARGUMENT_FIELDS.get(flag)
    const value = argv[index + 1]
    if (!field) {
      throw new Error(`Unknown runtime Windows source signature argument: ${flag}`)
    }
    if (result[field]) {
      throw new Error(`Duplicate runtime Windows source signature argument: ${flag}`)
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`Runtime Windows source signature ${flag} requires a value`)
    }
    result[field] = resolve(value)
  }
  for (const field of ARGUMENT_FIELDS.values()) {
    if (!result[field]) {
      throw new Error(`Missing required runtime Windows source signature argument: ${field}`)
    }
  }
  return result
}

export async function readSshRelayRuntimeWindowsSigningStageReport(path) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_SIGNING_REPORT_BYTES) {
    throw new Error('Runtime Windows signing-stage report must be one bounded regular file')
  }
  const source = await readFile(path, 'utf8')
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`Runtime Windows signing-stage report is not valid JSON: ${error.message}`)
  }
}

export function selectionFromSshRelayRuntimeWindowsSigningStageReport(identity, report) {
  assertExactFields(report, REPORT_FIELDS, 'signing-stage report')
  if (!report.payload || typeof report.payload !== 'object' || Array.isArray(report.payload)) {
    throw new Error('Runtime Windows signing-stage report has malformed payload evidence')
  }
  const selection = buildSshRelayRuntimeNativeSigningSelection(identity, report.assessments)
  const reportSelection = {
    tupleId: report.tupleId,
    platform: report.platform,
    policy: report.policy,
    immutableVendorFiles: report.immutableVendorFiles,
    signingFiles: report.signingFiles,
    preservedUpstreamFiles: report.preservedUpstreamFiles
  }
  const expected = {
    tupleId: selection.tupleId,
    platform: selection.platform,
    policy: selection.policy,
    immutableVendorFiles: selection.immutableVendorFiles,
    signingFiles: selection.signingFiles,
    preservedUpstreamFiles: selection.preservedUpstreamFiles
  }
  if (!isDeepStrictEqual(reportSelection, expected)) {
    // Why: retained signature evidence must describe the same hash-bound selection used for staging.
    throw new Error('Runtime Windows signing-stage report and authenticated selection disagree')
  }
  return selection
}

function localPath(root, portablePath) {
  return resolve(root, ...portablePath.split('/'))
}

export async function verifySshRelayRuntimeWindowsSourceSignatures({
  runtimeRoot,
  identity,
  selection,
  platform = process.platform,
  spawnSyncImpl = spawnSync
}) {
  if (platform !== 'win32') {
    throw new Error('Runtime Windows source signature verification requires Windows')
  }
  assertSshRelayRuntimeNativeSigningSelection(identity, selection)
  const rootMetadata = await lstat(resolve(runtimeRoot))
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Runtime Windows source signature verification requires a real runtime root')
  }
  const physicalRoot = await realpath(resolve(runtimeRoot))
  // Why: native trust probes run only after the entire unsigned source tree matches its identity.
  await verifyRuntimeTree(physicalRoot, identity)

  const sourceFiles = new Map(
    identity.entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry])
  )
  const targets = [
    ...selection.immutableVendorFiles.map((expectedSigner) => ({
      expectedSigner,
      signerKind: 'official-node'
    })),
    ...selection.preservedUpstreamFiles.map((expectedSigner) => ({
      expectedSigner,
      signerKind: 'preserved-upstream'
    }))
  ]
  const verifiedFiles = []
  for (const target of targets) {
    const entry = sourceFiles.get(target.expectedSigner.path)
    if (!entry) {
      throw new Error('Runtime Windows source signature target is missing from its identity')
    }
    verifiedFiles.push(
      await verifySshRelayRuntimeWindowsSignatureTarget({
        path: localPath(physicalRoot, entry.path),
        entry,
        ...target,
        spawnSyncImpl
      })
    )
  }
  return {
    tupleId: identity.tupleId,
    sourceContentId: identity.contentId,
    verifiedFiles
  }
}

async function main() {
  const options = parseSshRelayRuntimeWindowsSourceSignatureArguments(process.argv.slice(2))
  const [identity, report] = await Promise.all([
    readSshRelayRuntimeNativeSigningIdentity(options.identityPath),
    readSshRelayRuntimeWindowsSigningStageReport(options.signingReportPath)
  ])
  const selection = selectionFromSshRelayRuntimeWindowsSigningStageReport(identity, report)
  const result = await verifySshRelayRuntimeWindowsSourceSignatures({
    runtimeRoot: options.runtimeRoot,
    identity,
    selection
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `SSH relay runtime Windows source signature verification failed: ${error.stack ?? error}\n`
    )
    process.exitCode = 1
  })
}
