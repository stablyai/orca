import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'

const MAX_IDENTITY_BYTES = 4 * 1024 * 1024
const NATIVE_ROLES = new Set(['node', 'node-pty-native', 'parcel-watcher-native', 'native-runtime'])

const PLATFORM_CONTRACTS = Object.freeze({
  linux: {
    policy: 'linux-hash-only-v1',
    nodePath: 'bin/node',
    verificationCount: 3,
    signingAction: null,
    signingCount: 0
  },
  darwin: {
    policy: 'apple-developer-id-v1',
    nodePath: 'bin/node',
    verificationCount: 4,
    signingAction: 'developer-id-required',
    signingCount: 3
  },
  win32: {
    policy: 'signpath-authenticode-v1',
    nodePath: 'bin/node.exe',
    verificationCount: 6,
    signingAction: 'signpath-if-unsigned',
    signingCount: 5
  }
})

function platformForTuple(tupleId) {
  if (tupleId.startsWith('linux-')) {
    return 'linux'
  }
  if (tupleId.startsWith('darwin-')) {
    return 'darwin'
  }
  if (tupleId.startsWith('win32-')) {
    return 'win32'
  }
  throw new Error(`Runtime signing plan does not support tuple: ${tupleId}`)
}

function assertNativeExtension(platform, entry) {
  if (entry.role === 'node') {
    return
  }
  const accepted =
    platform === 'linux'
      ? entry.path.endsWith('.node')
      : platform === 'darwin'
        ? entry.path.endsWith('.node') ||
          entry.path.endsWith('.dylib') ||
          entry.path.endsWith('/spawn-helper')
        : entry.path.endsWith('.node') || entry.path.endsWith('.dll') || entry.path.endsWith('.exe')
  if (!accepted) {
    throw new Error(`Runtime signing plan rejects native file extension: ${entry.path}`)
  }
}

function signingFile(entry, action) {
  return { path: entry.path, role: entry.role, sourceSha256: entry.sha256, action }
}

function verificationFile(entry) {
  return { path: entry.path, role: entry.role, sourceSha256: entry.sha256 }
}

export function buildSshRelayRuntimeNativeSigningPlan(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('Runtime signing plan requires an identity object')
  }
  assertSshRelayRuntimeClosureEntries(identity)
  const platform = platformForTuple(identity.tupleId)
  if (identity.os !== platform) {
    throw new Error(`Runtime signing plan tuple and OS disagree: ${identity.tupleId}`)
  }
  const contract = PLATFORM_CONTRACTS[platform]
  const nativeFiles = identity.entries
    .filter((entry) => entry.type === 'file' && NATIVE_ROLES.has(entry.role))
    // Why: signing input order must match the portable byte ordering used by runtime identity.
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const nodeFiles = nativeFiles.filter((entry) => entry.role === 'node')
  if (nodeFiles.length !== 1 || nodeFiles[0].path !== contract.nodePath) {
    // Why: the signed official Node input is immutable and must never enter Orca's signing flow.
    throw new Error(`Runtime signing plan requires exact immutable Node path: ${contract.nodePath}`)
  }
  for (const entry of nativeFiles) {
    if (entry.mode !== 0o755 || typeof entry.sha256 !== 'string') {
      throw new Error(`Runtime signing plan requires executable authenticated bytes: ${entry.path}`)
    }
    assertNativeExtension(platform, entry)
  }
  if (nativeFiles.length !== contract.verificationCount) {
    throw new Error(`Runtime signing plan has unexpected native file count for ${identity.tupleId}`)
  }
  const signingCandidates = contract.signingAction
    ? nativeFiles
        .filter((entry) => entry.role !== 'node')
        .map((entry) => signingFile(entry, contract.signingAction))
    : []
  if (signingCandidates.length !== contract.signingCount) {
    throw new Error(
      `Runtime signing plan has unexpected signing target count for ${identity.tupleId}`
    )
  }
  return {
    tupleId: identity.tupleId,
    platform,
    policy: contract.policy,
    immutableVendorFiles: [signingFile(nodeFiles[0], 'preserve-exact-bytes')],
    signingCandidates,
    verificationFiles: nativeFiles.map(verificationFile)
  }
}

export function parseSshRelayRuntimeNativeSigningPlanArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--identity' || !argv[1]) {
    throw new Error(
      'Usage: node config/scripts/ssh-relay-runtime-native-signing-plan.mjs --identity <identity.json>'
    )
  }
  return { identityPath: resolve(argv[1]) }
}

export async function readSshRelayRuntimeNativeSigningIdentity(identityPath) {
  const metadata = await stat(identityPath)
  if (!metadata.isFile() || metadata.size > MAX_IDENTITY_BYTES) {
    throw new Error('Runtime signing identity must be one bounded regular file')
  }
  const source = await readFile(identityPath, 'utf8')
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`Runtime signing identity is not valid JSON: ${error.message}`)
  }
}

async function main() {
  const { identityPath } = parseSshRelayRuntimeNativeSigningPlanArguments(process.argv.slice(2))
  const identity = await readSshRelayRuntimeNativeSigningIdentity(identityPath)
  console.log(JSON.stringify(buildSshRelayRuntimeNativeSigningPlan(identity), null, 2))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`SSH relay runtime native signing plan failed: ${error}`)
    process.exitCode = 1
  })
}
