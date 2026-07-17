import { describe, expect, it } from 'vitest'

import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import { parseSshRelayArtifactManifest } from './ssh-relay-artifact-schema'
import { sshRelayRuntimeArchiveName } from './ssh-relay-release-asset'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity'

function finalizeTuple(manifest: ReturnType<typeof createSshRelayArtifactTestManifest>): void {
  const tuple = manifest.tuples[0]
  const files = tuple.entries.filter((entry) => entry.type === 'file')
  tuple.contentId = computeSshRelayRuntimeContentId(tuple)
  tuple.archive.name = sshRelayRuntimeArchiveName(tuple.tupleId, tuple.contentId)
  tuple.archive.fileCount = files.length
  tuple.archive.expandedSize = files.reduce((total, entry) => total + entry.size, 0)
}

function createWindowsManifest() {
  const manifest = createSshRelayArtifactTestManifest()
  const tuple = manifest.tuples[0]
  tuple.tupleId = 'win32-x64'
  tuple.os = 'win32'
  tuple.architecture = 'x64'
  tuple.compatibility = {
    kind: 'windows',
    minimumBuild: 19045,
    minimumOpenSshVersion: '8.1p1',
    minimumPowerShellVersion: '5.1',
    minimumDotNetFrameworkRelease: 528040
  }
  for (const entry of tuple.entries) {
    entry.path = entry.path
      .replace('bin/node', 'bin/node.exe')
      .replace('watcher-linux-x64-glibc', 'watcher-win32-x64')
      .replace(
        'node_modules/node-pty/build/Release/pty.node',
        'node_modules/node-pty/build/Release/conpty.node'
      )
  }
  tuple.entries.push(
    {
      path: 'node_modules/node-pty/build/Release/conpty',
      type: 'directory',
      mode: 0o755
    },
    {
      path: 'node_modules/node-pty/build/Release/conpty_console_list.node',
      type: 'file',
      role: 'node-pty-native',
      size: 31,
      mode: 0o755,
      sha256: `sha256:${'9'.repeat(64)}`
    },
    {
      path: 'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
      type: 'file',
      role: 'native-runtime',
      size: 32,
      mode: 0o755,
      sha256: `sha256:${'a'.repeat(64)}`
    },
    {
      path: 'node_modules/node-pty/build/Release/conpty/conpty.dll',
      type: 'file',
      role: 'native-runtime',
      size: 33,
      mode: 0o755,
      sha256: `sha256:${'b'.repeat(64)}`
    }
  )
  tuple.nativeVerification.policy = 'signpath-authenticode-v1'
  for (const file of tuple.nativeVerification.files) {
    file.path = file.path
      .replace('bin/node', 'bin/node.exe')
      .replace('watcher-linux-x64-glibc', 'watcher-win32-x64')
      .replace(
        'node_modules/node-pty/build/Release/pty.node',
        'node_modules/node-pty/build/Release/conpty.node'
      )
  }
  tuple.nativeVerification.files.push(
    {
      path: 'node_modules/node-pty/build/Release/conpty_console_list.node',
      sha256: `sha256:${'9'.repeat(64)}`
    },
    {
      path: 'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
      sha256: `sha256:${'a'.repeat(64)}`
    },
    {
      path: 'node_modules/node-pty/build/Release/conpty/conpty.dll',
      sha256: `sha256:${'b'.repeat(64)}`
    }
  )
  finalizeTuple(manifest)
  return manifest
}

describe('SSH relay artifact manifest schema', () => {
  it('accepts a complete internally consistent manifest', () => {
    const parsed = parseSshRelayArtifactManifest(createSshRelayArtifactTestManifest())

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.tuples[0].tupleId).toBe('linux-x64-glibc')
  })

  it('accepts the exact target-native Windows native closure and compatibility discriminator', () => {
    const parsed = parseSshRelayArtifactManifest(createWindowsManifest())
    const files = parsed.tuples[0].entries.filter((entry) => entry.type === 'file')

    expect(parsed.tuples[0].compatibility.kind).toBe('windows')
    expect(parsed.tuples[0].entries).toContainEqual(
      expect.objectContaining({ path: 'bin/node.exe', role: 'node' })
    )
    expect(files.filter((entry) => entry.role === 'node-pty-native')).toHaveLength(2)
    expect(files.filter((entry) => entry.role === 'native-runtime')).toHaveLength(2)
    expect(parsed.tuples[0].nativeVerification.files).toHaveLength(6)
  })

  it('rejects missing or extra tuple-specific Windows native role members', () => {
    const missing = createWindowsManifest()
    const missingPath = 'node_modules/node-pty/build/Release/conpty_console_list.node'
    missing.tuples[0].entries = missing.tuples[0].entries.filter(
      (entry) => entry.path !== missingPath
    )
    missing.tuples[0].nativeVerification.files = missing.tuples[0].nativeVerification.files.filter(
      (entry) => entry.path !== missingPath
    )
    finalizeTuple(missing)
    expect(() => parseSshRelayArtifactManifest(missing)).toThrow(/node-pty-native.*closure/i)

    const extra = createWindowsManifest()
    extra.tuples[0].entries.push({
      path: 'node_modules/node-pty/build/Release/conpty/unexpected.dll',
      type: 'file',
      role: 'native-runtime',
      size: 34,
      mode: 0o755,
      sha256: `sha256:${'c'.repeat(64)}`
    })
    extra.tuples[0].nativeVerification.files.push({
      path: 'node_modules/node-pty/build/Release/conpty/unexpected.dll',
      sha256: `sha256:${'c'.repeat(64)}`
    })
    finalizeTuple(extra)
    expect(() => parseSshRelayArtifactManifest(extra)).toThrow(/native-runtime.*closure/i)
  })

  it('rejects unsupported schema versions, extra fields, and non-canonical timestamps', () => {
    const unsupported = createSshRelayArtifactTestManifest() as unknown as Record<string, unknown>
    unsupported.schemaVersion = 2
    expect(() => parseSshRelayArtifactManifest(unsupported)).toThrow()

    const extra = createSshRelayArtifactTestManifest() as unknown as Record<string, unknown>
    extra.latest = true
    expect(() => parseSshRelayArtifactManifest(extra)).toThrow()

    const invalidDate = createSshRelayArtifactTestManifest()
    invalidDate.createdAt = '2026-02-31T00:00:00.000Z'
    expect(() => parseSshRelayArtifactManifest(invalidDate)).toThrow(/timestamp/i)
  })

  it('rejects build identity that disagrees with the exact tag', () => {
    const manifest = createSshRelayArtifactTestManifest()
    manifest.build.channel = 'stable'

    expect(() => parseSshRelayArtifactManifest(manifest)).toThrow(/build identity/i)
  })

  it('rejects duplicate tuple identities', () => {
    const manifest = createSshRelayArtifactTestManifest()
    manifest.tuples.push(structuredClone(manifest.tuples[0]))

    expect(() => parseSshRelayArtifactManifest(manifest)).toThrow(/duplicate tuple/i)
  })

  it('rejects exact and case-folded entry collisions', () => {
    for (const path of ['relay.js', 'RELAY.JS']) {
      const manifest = createSshRelayArtifactTestManifest()
      manifest.tuples[0].entries.push({
        path,
        type: 'file',
        role: 'runtime-javascript',
        size: 1,
        mode: 0o644,
        sha256: `sha256:${'e'.repeat(64)}`
      })
      expect(() => parseSshRelayArtifactManifest(manifest), path).toThrow(/colliding path/i)
    }
  })

  it.each([
    '/absolute',
    '../escape',
    'nested/../escape',
    'C:/drive',
    '//server/share',
    'node_modules\\escape',
    'relay.js:stream',
    'CON',
    'aux.txt',
    'trailing.',
    'white space',
    `${'a/'.repeat(32)}file`,
    'a'.repeat(241)
  ])('rejects unsafe portable path %s', (path) => {
    const manifest = createSshRelayArtifactTestManifest()
    manifest.tuples[0].entries[1].path = path

    expect(() => parseSshRelayArtifactManifest(manifest)).toThrow(/unsafe artifact path/i)
  })

  it('rejects inconsistent aggregate counts and sizes', () => {
    const countMismatch = createSshRelayArtifactTestManifest()
    countMismatch.tuples[0].archive.fileCount += 1
    expect(() => parseSshRelayArtifactManifest(countMismatch)).toThrow(/file count/i)

    const sizeMismatch = createSshRelayArtifactTestManifest()
    sizeMismatch.tuples[0].archive.expandedSize += 1
    expect(() => parseSshRelayArtifactManifest(sizeMismatch)).toThrow(/expanded size/i)
  })

  it('rejects archive, expanded-tree, per-file, and entry-count limit violations', () => {
    const archive = createSshRelayArtifactTestManifest()
    archive.tuples[0].archive.size = 100 * 1024 * 1024 + 1
    expect(() => parseSshRelayArtifactManifest(archive)).toThrow()

    const expanded = createSshRelayArtifactTestManifest()
    expanded.tuples[0].archive.expandedSize = 350 * 1024 * 1024 + 1
    expect(() => parseSshRelayArtifactManifest(expanded)).toThrow()

    const file = createSshRelayArtifactTestManifest()
    const relay = file.tuples[0].entries.find(
      (entry) => entry.type === 'file' && entry.role === 'relay'
    )
    if (!relay || relay.type !== 'file') {
      throw new Error('test fixture missing relay file')
    }
    relay.size = 250 * 1024 * 1024 + 1
    expect(() => parseSshRelayArtifactManifest(file)).toThrow()

    const entries = createSshRelayArtifactTestManifest()
    entries.tuples[0].entries = Array.from({ length: 5_001 }, (_, index) => ({
      path: `entry-${index}`,
      type: 'directory' as const,
      mode: 0o755 as const
    }))
    expect(() => parseSshRelayArtifactManifest(entries)).toThrow()
  })

  it('rejects undeclared parents and non-file archive entry types', () => {
    const missingParent = createSshRelayArtifactTestManifest()
    missingParent.tuples[0].entries[1].path = 'missing/node'
    expect(() => parseSshRelayArtifactManifest(missingParent)).toThrow(/undeclared parent/i)

    const symlink = createSshRelayArtifactTestManifest()
    symlink.tuples[0].entries.push({
      path: 'node-link',
      type: 'symlink',
      target: 'bin/node'
    } as never)
    expect(() => parseSshRelayArtifactManifest(symlink)).toThrow()
  })

  it('rejects a missing required executable role', () => {
    const manifest = createSshRelayArtifactTestManifest()
    manifest.tuples[0].entries = manifest.tuples[0].entries.filter(
      (entry) => entry.type !== 'file' || entry.role !== 'node-pty-native'
    )

    expect(() => parseSshRelayArtifactManifest(manifest)).toThrow(/node-pty-native/i)
  })

  it('requires bundled license metadata and executable bundled Node mode', () => {
    const missingLicense = createSshRelayArtifactTestManifest()
    missingLicense.tuples[0].entries = missingLicense.tuples[0].entries.filter(
      (entry) => entry.type !== 'file' || entry.role !== 'license'
    )
    expect(() => parseSshRelayArtifactManifest(missingLicense)).toThrow(/license/i)

    const nonExecutableNode = createSshRelayArtifactTestManifest()
    const node = nonExecutableNode.tuples[0].entries.find(
      (entry) => entry.type === 'file' && entry.role === 'node'
    )
    if (!node || node.type !== 'file') {
      throw new Error('test fixture missing Node')
    }
    node.mode = 0o644
    expect(() => parseSshRelayArtifactManifest(nonExecutableNode)).toThrow(/executable.*Node/i)
  })

  it('rejects a native optional package for another tuple', () => {
    const manifest = createSshRelayArtifactTestManifest()
    for (const entry of manifest.tuples[0].entries) {
      entry.path = entry.path.replace('watcher-linux-x64-glibc', 'watcher-linux-arm64-glibc')
    }

    expect(() => parseSshRelayArtifactManifest(manifest)).toThrow(/native watcher package/i)
  })

  it('rejects native attestation hashes that do not match runtime bytes', () => {
    const manifest = createSshRelayArtifactTestManifest()
    manifest.tuples[0].nativeVerification.files[0].sha256 = `sha256:${'f'.repeat(64)}`

    expect(() => parseSshRelayArtifactManifest(manifest)).toThrow(/attested hash/i)
  })

  it('rejects duplicate native attestation paths and the wrong platform policy', () => {
    const duplicate = createSshRelayArtifactTestManifest()
    duplicate.tuples[0].nativeVerification.files.push(
      structuredClone(duplicate.tuples[0].nativeVerification.files[0])
    )
    expect(() => parseSshRelayArtifactManifest(duplicate)).toThrow(/duplicate native attestation/i)

    const wrongPolicy = createSshRelayArtifactTestManifest()
    wrongPolicy.tuples[0].nativeVerification.policy = 'apple-developer-id-v1'
    expect(() => parseSshRelayArtifactManifest(wrongPolicy)).toThrow(/verification policy/i)
  })

  it('rejects duplicate signature keys and malformed signature bytes', () => {
    const duplicate = createSshRelayArtifactTestManifest()
    duplicate.signatures.push(structuredClone(duplicate.signatures[0]))
    expect(() => parseSshRelayArtifactManifest(duplicate)).toThrow(/duplicate signature/i)

    const malformed = createSshRelayArtifactTestManifest()
    malformed.signatures[0].signature = Buffer.alloc(63).toString('base64')
    expect(() => parseSshRelayArtifactManifest(malformed)).toThrow(/64 bytes/i)

    const algorithm = createSshRelayArtifactTestManifest()
    algorithm.signatures[0].algorithm = 'rsa-v1' as never
    expect(() => parseSshRelayArtifactManifest(algorithm)).toThrow()
  })

  it('rejects a content identity or archive name that is not derived from the runtime', () => {
    const identityMismatch = createSshRelayArtifactTestManifest()
    identityMismatch.tuples[0].contentId = `sha256:${'f'.repeat(64)}`
    expect(() => parseSshRelayArtifactManifest(identityMismatch)).toThrow(/content identity/i)

    const nameMismatch = createSshRelayArtifactTestManifest()
    nameMismatch.tuples[0].archive.name = 'latest.tar.br'
    expect(() => parseSshRelayArtifactManifest(nameMismatch)).toThrow(/archive name/i)
  })

  it('rejects platform-field conflicts and non-canonical digests', () => {
    const conflict = createSshRelayArtifactTestManifest()
    conflict.tuples[0].architecture = 'arm64'
    expect(() => parseSshRelayArtifactManifest(conflict)).toThrow(/platform fields/i)

    const digest = createSshRelayArtifactTestManifest()
    digest.tuples[0].archive.sha256 = `sha256:${'A'.repeat(64)}`
    expect(() => parseSshRelayArtifactManifest(digest)).toThrow()
  })
})
