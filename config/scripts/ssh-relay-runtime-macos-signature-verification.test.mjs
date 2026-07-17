import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { applySshRelayRuntimeNativeSigningReturn } from './ssh-relay-runtime-native-signing-apply.mjs'
import { buildSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'
import {
  parseSshRelayRuntimeMacosCodeSignature,
  verifySshRelayRuntimeMacosSignatures
} from './ssh-relay-runtime-macos-signature-verification.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'

const ORCA_TEAM = 'ABCDE12345'
const NODE_TEAM = 'HX7739G8FX'

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function codeSignature(authority, teamIdentifier) {
  return [
    'Executable=/tmp/runtime/native',
    'Format=Mach-O thin (arm64)',
    `Authority=${authority}`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    `TeamIdentifier=${teamIdentifier}`,
    'Signature size=9000'
  ].join('\n')
}

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-macos-signature-'))
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot)
  const entries = []
  for (const entry of expectedSshRelayRuntimeClosureEntries('darwin-arm64')) {
    if (entry.type === 'directory') {
      await mkdir(join(runtimeRoot, ...entry.path.split('/')), {
        recursive: true,
        mode: entry.mode
      })
      entries.push(entry)
      continue
    }
    const bytes = Buffer.from(`fixture:${entry.path}`)
    const path = join(runtimeRoot, ...entry.path.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { mode: entry.mode })
    entries.push({ ...entry, size: bytes.length, sha256: digest(bytes) })
  }
  const base = {
    identitySchemaVersion: 1,
    tupleId: 'darwin-arm64',
    os: 'darwin',
    architecture: 'arm64',
    compatibility: sshRelayRuntimeCompatibility['darwin-arm64'],
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries
  }
  const files = entries.filter((entry) => entry.type === 'file')
  return {
    root,
    runtimeRoot,
    identity: {
      ...base,
      contentId: computeSshRelayRuntimeContentId(base),
      fileCount: files.length,
      expandedSize: files.reduce((total, entry) => total + entry.size, 0)
    }
  }
}

async function signedFixture() {
  const fixture = await runtimeFixture()
  const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
  const returnedRoot = join(fixture.root, 'returned')
  for (const entry of selection.signingFiles) {
    const path = join(returnedRoot, ...entry.path.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `signed:${entry.path}`, { mode: 0o755 })
  }
  const finalRuntimeRoot = join(fixture.root, 'final-runtime')
  const applied = await applySshRelayRuntimeNativeSigningReturn({
    sourceRuntimeRoot: fixture.runtimeRoot,
    returnedRoot,
    outputRuntimeRoot: finalRuntimeRoot,
    identity: fixture.identity,
    selection
  })
  return { ...fixture, finalRuntimeRoot, selection, finalIdentity: applied.identity }
}

function successfulCodesign(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0] === '--verify') {
      return { status: 0, stdout: '', stderr: '' }
    }
    const node = args.at(-1).endsWith(join('bin', 'node'))
    return {
      status: 0,
      stdout: '',
      stderr: node
        ? codeSignature(`Developer ID Application: Node.js Foundation (${NODE_TEAM})`, NODE_TEAM)
        : codeSignature(`Developer ID Application: Orca Test (${ORCA_TEAM})`, ORCA_TEAM)
    }
  }
}

describe('SSH relay runtime macOS signature verification', () => {
  it('verifies the complete final tree before exact Node and Orca Developer ID policy', async () => {
    const fixture = await signedFixture()
    const calls = []
    try {
      const report = await verifySshRelayRuntimeMacosSignatures({
        runtimeRoot: fixture.finalRuntimeRoot,
        sourceIdentity: fixture.identity,
        finalIdentity: fixture.finalIdentity,
        selection: fixture.selection,
        expectedOrcaTeamIdentifier: ORCA_TEAM,
        platform: 'darwin',
        spawnSyncImpl: successfulCodesign(calls)
      })

      expect(report.tupleId).toBe('darwin-arm64')
      expect(report.verifiedFiles).toHaveLength(4)
      expect(report.verifiedFiles.find((entry) => entry.role === 'node')).toEqual(
        expect.objectContaining({ teamIdentifier: NODE_TEAM, signerKind: 'official-node' })
      )
      expect(calls).toHaveLength(8)
      expect(calls.every((call) => call.command === '/usr/bin/codesign')).toBe(true)
      expect(calls.every((call) => call.options.timeout === 30_000)).toBe(true)
      expect(calls.every((call) => call.options.maxBuffer === 64 * 1024)).toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an unexpected Node authority or Orca team', async () => {
    const fixture = await signedFixture()
    try {
      const wrongNode = successfulCodesign([])
      await expect(
        verifySshRelayRuntimeMacosSignatures({
          runtimeRoot: fixture.finalRuntimeRoot,
          sourceIdentity: fixture.identity,
          finalIdentity: fixture.finalIdentity,
          selection: fixture.selection,
          expectedOrcaTeamIdentifier: ORCA_TEAM,
          platform: 'darwin',
          spawnSyncImpl: (command, args, options) => {
            const result = wrongNode(command, args, options)
            return args[0] === '--display' && args.at(-1).endsWith(join('bin', 'node'))
              ? {
                  ...result,
                  stderr: codeSignature(
                    'Developer ID Application: Other (BADTEAM123)',
                    'BADTEAM123'
                  )
                }
              : result
          }
        })
      ).rejects.toThrow(/official Node signer policy/i)

      await expect(
        verifySshRelayRuntimeMacosSignatures({
          runtimeRoot: fixture.finalRuntimeRoot,
          sourceIdentity: fixture.identity,
          finalIdentity: fixture.finalIdentity,
          selection: fixture.selection,
          expectedOrcaTeamIdentifier: 'WRONG12345',
          platform: 'darwin',
          spawnSyncImpl: successfulCodesign([])
        })
      ).rejects.toThrow(/Orca signer policy/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects malformed display output, ad-hoc signatures, and strict verification failure', () => {
    expect(() => parseSshRelayRuntimeMacosCodeSignature('')).toThrow(/empty/i)
    expect(() =>
      parseSshRelayRuntimeMacosCodeSignature('Authority=A\nAuthority=A\nTeamIdentifier=T')
    ).toThrow(/authority chain/i)
    expect(() =>
      parseSshRelayRuntimeMacosCodeSignature('Signature=adhoc\nTeamIdentifier=not set')
    ).toThrow(/Developer ID/i)
  })

  it('fails closed on codesign errors, nonzero status, or excessive output', async () => {
    const fixture = await signedFixture()
    try {
      const common = {
        runtimeRoot: fixture.finalRuntimeRoot,
        sourceIdentity: fixture.identity,
        finalIdentity: fixture.finalIdentity,
        selection: fixture.selection,
        expectedOrcaTeamIdentifier: ORCA_TEAM,
        platform: 'darwin'
      }
      await expect(
        verifySshRelayRuntimeMacosSignatures({
          ...common,
          spawnSyncImpl: () => ({ error: new Error('timed out') })
        })
      ).rejects.toThrow(/timed out/i)
      await expect(
        verifySshRelayRuntimeMacosSignatures({
          ...common,
          spawnSyncImpl: () => ({ status: 9, stdout: '', stderr: '' })
        })
      ).rejects.toThrow(/exit code 9/i)
      await expect(
        verifySshRelayRuntimeMacosSignatures({
          ...common,
          spawnSyncImpl: () => ({ status: 0, stdout: 'x'.repeat(64 * 1024 + 1), stderr: '' })
        })
      ).rejects.toThrow(/output bound/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('authenticates the tree before spawning and rejects mutation during native probes', async () => {
    const fixture = await signedFixture()
    let calls = 0
    try {
      await appendFile(join(fixture.finalRuntimeRoot, 'relay.js'), ':mutated')
      await expect(
        verifySshRelayRuntimeMacosSignatures({
          runtimeRoot: fixture.finalRuntimeRoot,
          sourceIdentity: fixture.identity,
          finalIdentity: fixture.finalIdentity,
          selection: fixture.selection,
          expectedOrcaTeamIdentifier: ORCA_TEAM,
          platform: 'darwin',
          spawnSyncImpl: () => {
            calls += 1
            return { status: 0, stdout: '', stderr: '' }
          }
        })
      ).rejects.toThrow(/integrity mismatch/i)
      expect(calls).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }

    const raced = await signedFixture()
    try {
      const spawn = successfulCodesign([])
      let mutated = false
      await expect(
        verifySshRelayRuntimeMacosSignatures({
          runtimeRoot: raced.finalRuntimeRoot,
          sourceIdentity: raced.identity,
          finalIdentity: raced.finalIdentity,
          selection: raced.selection,
          expectedOrcaTeamIdentifier: ORCA_TEAM,
          platform: 'darwin',
          spawnSyncImpl: (command, args, options) => {
            if (!mutated) {
              mutated = true
              appendFileSync(args.at(-1), ':raced')
            }
            return spawn(command, args, options)
          }
        })
      ).rejects.toThrow(/changed during signature verification/i)
    } finally {
      await rm(raced.root, { recursive: true, force: true })
    }
  })

  it('rejects cross-platform execution and a stale signing selection', async () => {
    const fixture = await signedFixture()
    try {
      await expect(
        verifySshRelayRuntimeMacosSignatures({
          runtimeRoot: fixture.finalRuntimeRoot,
          sourceIdentity: fixture.identity,
          finalIdentity: fixture.finalIdentity,
          selection: fixture.selection,
          expectedOrcaTeamIdentifier: ORCA_TEAM,
          platform: 'linux',
          spawnSyncImpl: () => {
            throw new Error('must not spawn')
          }
        })
      ).rejects.toThrow(/requires macOS/i)

      fixture.selection.signingFiles[0].sourceSha256 = `sha256:${'f'.repeat(64)}`
      await expect(
        verifySshRelayRuntimeMacosSignatures({
          runtimeRoot: fixture.finalRuntimeRoot,
          sourceIdentity: fixture.identity,
          finalIdentity: fixture.finalIdentity,
          selection: fixture.selection,
          expectedOrcaTeamIdentifier: ORCA_TEAM,
          platform: 'darwin',
          spawnSyncImpl: () => {
            throw new Error('must not spawn')
          }
        })
      ).rejects.toThrow(/selection and identity disagree/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects stale archive metadata and out-of-bound signed identity growth before probes', async () => {
    const fixture = await signedFixture()
    let calls = 0
    try {
      const common = {
        runtimeRoot: fixture.finalRuntimeRoot,
        sourceIdentity: fixture.identity,
        selection: fixture.selection,
        expectedOrcaTeamIdentifier: ORCA_TEAM,
        platform: 'darwin',
        spawnSyncImpl: () => {
          calls += 1
          return { status: 0, stdout: '', stderr: '' }
        }
      }
      const staleArchive = structuredClone(fixture.finalIdentity)
      staleArchive.archive = { fileName: 'unsigned.tar.br' }
      await expect(
        verifySshRelayRuntimeMacosSignatures({ ...common, finalIdentity: staleArchive })
      ).rejects.toThrow(/does not match its unsigned source/i)

      const oversized = structuredClone(fixture.finalIdentity)
      const first = oversized.entries.find(
        (entry) => entry.path === fixture.selection.signingFiles[0].path
      )
      const source = fixture.identity.entries.find((entry) => entry.path === first.path)
      first.size = source.size + 4 * 1024 * 1024 + 1
      await expect(
        verifySshRelayRuntimeMacosSignatures({ ...common, finalIdentity: oversized })
      ).rejects.toThrow(/identity transition is invalid/i)
      expect(calls).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
