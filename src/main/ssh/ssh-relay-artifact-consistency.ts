import type { SshRelayRuntimeTuple } from './ssh-relay-artifact-schema'
import {
  assertSafeSshRelayArtifactPath,
  foldSshRelayArtifactPath
} from './ssh-relay-artifact-path-policy'
import { sshRelayRuntimeArchiveName } from './ssh-relay-release-asset'
import { computeSshRelayRuntimeContentId, type SshRelayDigest } from './ssh-relay-runtime-identity'

function expectedTupleId(tuple: SshRelayRuntimeTuple): string {
  if (tuple.os === 'linux' && tuple.compatibility.kind === 'linux') {
    return `linux-${tuple.architecture}-${tuple.compatibility.libc.family}`
  }
  return `${tuple.os}-${tuple.architecture}`
}

function assertRequiredRuntimeEntries(tuple: SshRelayRuntimeTuple): void {
  const files = tuple.entries.filter((entry) => entry.type === 'file')
  const expectedPaths = new Map([
    // Why: every archive keeps bundled Node under `bin`, including the Windows ZIP.
    ['node', tuple.os === 'win32' ? 'bin/node.exe' : 'bin/node'],
    ['relay', 'relay.js'],
    ['relay-watcher', 'relay-watcher.js']
  ])
  for (const role of ['node', 'relay', 'relay-watcher', 'parcel-watcher-native']) {
    const matching = files.filter((file) => file.role === role)
    if (matching.length !== 1) {
      throw new Error(`Runtime tuple ${tuple.tupleId} requires exactly one ${role} entry`)
    }
    const expectedPath = expectedPaths.get(role)
    if (expectedPath && matching[0].path !== expectedPath) {
      throw new Error(`Runtime tuple ${tuple.tupleId} has invalid ${role} path`)
    }
  }
  const nativePaths =
    tuple.os === 'win32'
      ? {
          'node-pty-native': [
            'node_modules/node-pty/build/Release/conpty.node',
            'node_modules/node-pty/build/Release/conpty_console_list.node'
          ],
          'native-runtime': [
            'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
            'node_modules/node-pty/build/Release/conpty/conpty.dll'
          ]
        }
      : {
          'node-pty-native': ['node_modules/node-pty/build/Release/pty.node'],
          'native-runtime':
            tuple.os === 'darwin' ? ['node_modules/node-pty/build/Release/spawn-helper'] : []
        }
  for (const [role, expected] of Object.entries(nativePaths)) {
    const actual = files
      .filter((entry) => entry.role === role)
      .map((entry) => entry.path)
      .sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Runtime tuple ${tuple.tupleId} has invalid ${role} closure`)
    }
  }
  for (const requiredPath of [
    'node_modules/node-pty/package.json',
    'node_modules/@parcel/watcher/package.json'
  ]) {
    if (!files.some((file) => file.path === requiredPath)) {
      throw new Error(`Runtime tuple ${tuple.tupleId} is missing ${requiredPath}`)
    }
  }
  if (!files.some((file) => file.role === 'license')) {
    throw new Error(`Runtime tuple ${tuple.tupleId} requires bundled license metadata`)
  }
  const node = files.find((file) => file.role === 'node')
  if (node?.mode !== 0o755) {
    throw new Error(`Runtime tuple ${tuple.tupleId} requires executable bundled Node mode`)
  }
}

function assertEntryTree(tuple: SshRelayRuntimeTuple): void {
  const paths = new Set<string>()
  const foldedPaths = new Set<string>()
  const directories = new Set(
    tuple.entries.filter((entry) => entry.type === 'directory').map((entry) => entry.path)
  )
  for (const entry of tuple.entries) {
    assertSafeSshRelayArtifactPath(entry.path)
    const folded = foldSshRelayArtifactPath(entry.path)
    if (paths.has(entry.path) || foldedPaths.has(folded)) {
      throw new Error(`Runtime tuple ${tuple.tupleId} has colliding path: ${entry.path}`)
    }
    paths.add(entry.path)
    foldedPaths.add(folded)
    const separator = entry.path.lastIndexOf('/')
    if (separator > 0 && !directories.has(entry.path.slice(0, separator))) {
      throw new Error(`Runtime tuple ${tuple.tupleId} has undeclared parent for ${entry.path}`)
    }
  }
}

function expectedWatcherPackage(tuple: SshRelayRuntimeTuple): string {
  if (tuple.os === 'linux' && tuple.compatibility.kind === 'linux') {
    return `node_modules/@parcel/watcher-linux-${tuple.architecture}-${tuple.compatibility.libc.family}`
  }
  return `node_modules/@parcel/watcher-${tuple.os}-${tuple.architecture}`
}

function assertNativePackages(tuple: SshRelayRuntimeTuple): void {
  const watcherPackage = expectedWatcherPackage(tuple)
  for (const entry of tuple.entries) {
    if (
      entry.path.startsWith('node_modules/@parcel/watcher-') &&
      entry.path !== watcherPackage &&
      !entry.path.startsWith(`${watcherPackage}/`)
    ) {
      throw new Error(`Runtime tuple ${tuple.tupleId} contains an extra native watcher package`)
    }
  }
  const expectedPolicy =
    tuple.os === 'linux'
      ? 'linux-hash-only-v1'
      : tuple.os === 'darwin'
        ? 'apple-developer-id-v1'
        : 'signpath-authenticode-v1'
  if (tuple.nativeVerification.policy !== expectedPolicy) {
    throw new Error(`Runtime tuple ${tuple.tupleId} has the wrong native verification policy`)
  }
}

function assertNativeAttestation(tuple: SshRelayRuntimeTuple): void {
  const attestations = new Map<string, SshRelayDigest>()
  for (const attestation of tuple.nativeVerification.files) {
    if (attestations.has(attestation.path)) {
      throw new Error(`Runtime tuple ${tuple.tupleId} has duplicate native attestation path`)
    }
    attestations.set(attestation.path, attestation.sha256)
  }
  const requiredRoles = new Set([
    'node',
    'node-pty-native',
    'parcel-watcher-native',
    'native-runtime'
  ])
  for (const entry of tuple.entries) {
    if (entry.type !== 'file' || !requiredRoles.has(entry.role)) {
      continue
    }
    if (attestations.get(entry.path) !== entry.sha256) {
      throw new Error(
        `Runtime tuple ${tuple.tupleId} has an invalid attested hash for ${entry.path}`
      )
    }
  }
  for (const [path, hash] of attestations) {
    const entry = tuple.entries.find((candidate) => candidate.path === path)
    if (!entry || entry.type !== 'file' || entry.sha256 !== hash) {
      throw new Error(
        `Runtime tuple ${tuple.tupleId} attests a missing or mismatched file: ${path}`
      )
    }
  }
}

export function assertSshRelayRuntimeTupleConsistency(tuple: SshRelayRuntimeTuple): void {
  const expectedCompatibilityKind = tuple.os === 'win32' ? 'windows' : tuple.os
  if (
    expectedTupleId(tuple) !== tuple.tupleId ||
    tuple.compatibility.kind !== expectedCompatibilityKind
  ) {
    throw new Error(`Runtime tuple identity does not match its platform fields: ${tuple.tupleId}`)
  }
  assertEntryTree(tuple)
  assertRequiredRuntimeEntries(tuple)
  assertNativePackages(tuple)
  assertNativeAttestation(tuple)

  const files = tuple.entries.filter((entry) => entry.type === 'file')
  const expandedSize = files.reduce((total, file) => total + file.size, 0)
  if (tuple.archive.fileCount !== files.length) {
    throw new Error(`Runtime tuple ${tuple.tupleId} archive file count is inconsistent`)
  }
  if (tuple.archive.expandedSize !== expandedSize) {
    throw new Error(`Runtime tuple ${tuple.tupleId} archive expanded size is inconsistent`)
  }
  const contentId = computeSshRelayRuntimeContentId(tuple)
  if (tuple.contentId !== contentId) {
    throw new Error(`Runtime tuple ${tuple.tupleId} content identity is inconsistent`)
  }
  if (tuple.archive.name !== sshRelayRuntimeArchiveName(tuple.tupleId, tuple.contentId)) {
    throw new Error(`Runtime tuple ${tuple.tupleId} archive name is inconsistent`)
  }
}
