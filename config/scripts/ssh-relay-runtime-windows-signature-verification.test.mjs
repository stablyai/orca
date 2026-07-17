import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { applySshRelayRuntimeNativeSigningReturn } from './ssh-relay-runtime-native-signing-apply.mjs'
import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'
import { buildSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'
import {
  OFFICIAL_NODE_WINDOWS_SIGNER_SUBJECT,
  ORCA_WINDOWS_SIGNER_SUBJECT,
  verifySshRelayRuntimeWindowsSignatures
} from './ssh-relay-runtime-windows-signature-verification.mjs'

const MICROSOFT_SUBJECT =
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-windows-signature-'))
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot)
  const entries = []
  for (const entry of expectedSshRelayRuntimeClosureEntries('win32-x64')) {
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
    tupleId: 'win32-x64',
    os: 'win32',
    architecture: 'x64',
    compatibility: sshRelayRuntimeCompatibility['win32-x64'],
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

function assessmentsFor(identity) {
  return buildSshRelayRuntimeNativeSigningPlan(identity).signingCandidates.map((entry, index) => {
    const preserved = entry.path.endsWith('/OpenConsole.exe') || entry.path.endsWith('/conpty.dll')
    return preserved
      ? {
          path: entry.path,
          sourceSha256: entry.sourceSha256,
          status: 'valid-upstream',
          signerSubject: MICROSOFT_SUBJECT,
          signerThumbprint: `${index + 1}`.repeat(40)
        }
      : { path: entry.path, sourceSha256: entry.sourceSha256, status: 'unsigned' }
  })
}

async function signedFixture() {
  const fixture = await runtimeFixture()
  const selection = buildSshRelayRuntimeNativeSigningSelection(
    fixture.identity,
    assessmentsFor(fixture.identity)
  )
  const returnedRoot = join(fixture.root, 'returned')
  for (const entry of selection.signingFiles) {
    const path = join(returnedRoot, ...entry.path.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `signed:${entry.path}`)
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

function signatureJson(signerSubject, signerThumbprint) {
  return JSON.stringify({ status: 'Valid', signerSubject, signerThumbprint })
}

function entryForPhysicalPath(selection, physicalPath) {
  return [
    ...selection.immutableVendorFiles,
    ...selection.signingFiles,
    ...selection.preservedUpstreamFiles
  ].find((entry) => physicalPath.endsWith(join(...entry.path.split('/'))))
}

function successfulAuthenticode(selection, calls, override = () => undefined) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const physicalPath = options.env.ORCA_SSH_RELAY_AUTHENTICODE_FILE
    const entry = entryForPhysicalPath(selection, physicalPath)
    const overridden = override(entry)
    if (overridden) {
      return { status: 0, stdout: JSON.stringify(overridden), stderr: '' }
    }
    if (entry.action === 'preserve-exact-bytes') {
      return {
        status: 0,
        stdout: signatureJson(OFFICIAL_NODE_WINDOWS_SIGNER_SUBJECT, 'A'.repeat(40)),
        stderr: ''
      }
    }
    if (entry.action === 'preserve-valid-upstream') {
      return {
        status: 0,
        stdout: signatureJson(entry.signerSubject, entry.signerThumbprint),
        stderr: ''
      }
    }
    return {
      status: 0,
      stdout: signatureJson(ORCA_WINDOWS_SIGNER_SUBJECT, 'F'.repeat(40)),
      stderr: ''
    }
  }
}

describe('SSH relay runtime Windows signature verification', () => {
  it('pins exact official Node and Orca SignPath signer subjects', () => {
    expect(OFFICIAL_NODE_WINDOWS_SIGNER_SUBJECT).toBe(
      'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
    )
    expect(ORCA_WINDOWS_SIGNER_SUBJECT).toBe(
      'CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US'
    )
  })

  it('verifies the complete final tree before exact Node, SignPath, and preserved signer policy', async () => {
    const fixture = await signedFixture()
    const calls = []
    try {
      const report = await verifySshRelayRuntimeWindowsSignatures({
        runtimeRoot: fixture.finalRuntimeRoot,
        sourceIdentity: fixture.identity,
        finalIdentity: fixture.finalIdentity,
        selection: fixture.selection,
        platform: 'win32',
        spawnSyncImpl: successfulAuthenticode(fixture.selection, calls)
      })

      expect(report.tupleId).toBe('win32-x64')
      expect(report.verifiedFiles).toHaveLength(6)
      expect(report.verifiedFiles.find((entry) => entry.role === 'node')).toEqual(
        expect.objectContaining({
          signerKind: 'official-node',
          signerSubject: OFFICIAL_NODE_WINDOWS_SIGNER_SUBJECT
        })
      )
      expect(calls).toHaveLength(6)
      expect(calls.every((call) => call.command === 'pwsh')).toBe(true)
      expect(calls.every((call) => call.options.timeout === 30_000)).toBe(true)
      expect(calls.every((call) => call.options.maxBuffer === 64 * 1024)).toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects unexpected official Node, SignPath, and preserved signer identities', async () => {
    const fixture = await signedFixture()
    const common = {
      runtimeRoot: fixture.finalRuntimeRoot,
      sourceIdentity: fixture.identity,
      finalIdentity: fixture.finalIdentity,
      selection: fixture.selection,
      platform: 'win32'
    }
    try {
      await expect(
        verifySshRelayRuntimeWindowsSignatures({
          ...common,
          spawnSyncImpl: successfulAuthenticode(fixture.selection, [], (entry) =>
            entry.action === 'preserve-exact-bytes'
              ? {
                  status: 'Valid',
                  signerSubject: 'CN=Unexpected Node Signer',
                  signerThumbprint: 'A'.repeat(40)
                }
              : undefined
          )
        })
      ).rejects.toThrow(/official Node signer policy/i)

      await expect(
        verifySshRelayRuntimeWindowsSignatures({
          ...common,
          spawnSyncImpl: successfulAuthenticode(fixture.selection, [], (entry) =>
            entry.action === 'signpath-required'
              ? {
                  status: 'Valid',
                  signerSubject: 'CN=Unexpected Orca Signer',
                  signerThumbprint: 'F'.repeat(40)
                }
              : undefined
          )
        })
      ).rejects.toThrow(/Orca signer policy/i)

      await expect(
        verifySshRelayRuntimeWindowsSignatures({
          ...common,
          spawnSyncImpl: successfulAuthenticode(fixture.selection, [], (entry) =>
            entry.action === 'preserve-valid-upstream'
              ? {
                  status: 'Valid',
                  signerSubject: entry.signerSubject,
                  signerThumbprint: '0'.repeat(40)
                }
              : undefined
          )
        })
      ).rejects.toThrow(/preserved upstream signer policy/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed on invalid signature status and bounded probe failure', async () => {
    const fixture = await signedFixture()
    const common = {
      runtimeRoot: fixture.finalRuntimeRoot,
      sourceIdentity: fixture.identity,
      finalIdentity: fixture.finalIdentity,
      selection: fixture.selection,
      platform: 'win32'
    }
    try {
      await expect(
        verifySshRelayRuntimeWindowsSignatures({
          ...common,
          spawnSyncImpl: () => ({
            status: 0,
            stdout: JSON.stringify({
              status: 'NotSigned',
              signerSubject: null,
              signerThumbprint: null
            }),
            stderr: ''
          })
        })
      ).rejects.toThrow(/requires a valid Authenticode signature/i)
      await expect(
        verifySshRelayRuntimeWindowsSignatures({
          ...common,
          spawnSyncImpl: () => ({ error: new Error('timed out') })
        })
      ).rejects.toThrow(/timed out/i)
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
        verifySshRelayRuntimeWindowsSignatures({
          runtimeRoot: fixture.finalRuntimeRoot,
          sourceIdentity: fixture.identity,
          finalIdentity: fixture.finalIdentity,
          selection: fixture.selection,
          platform: 'win32',
          spawnSyncImpl: () => {
            calls += 1
            throw new Error('must not spawn')
          }
        })
      ).rejects.toThrow(/integrity mismatch/i)
      expect(calls).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }

    const raced = await signedFixture()
    try {
      const spawn = successfulAuthenticode(raced.selection, [])
      let mutated = false
      await expect(
        verifySshRelayRuntimeWindowsSignatures({
          runtimeRoot: raced.finalRuntimeRoot,
          sourceIdentity: raced.identity,
          finalIdentity: raced.finalIdentity,
          selection: raced.selection,
          platform: 'win32',
          spawnSyncImpl: (command, args, options) => {
            if (!mutated) {
              mutated = true
              appendFileSync(options.env.ORCA_SSH_RELAY_AUTHENTICODE_FILE, ':raced')
            }
            return spawn(command, args, options)
          }
        })
      ).rejects.toThrow(/changed during signature verification/i)
    } finally {
      await rm(raced.root, { recursive: true, force: true })
    }
  })

  it('rejects cross-platform execution and stale selection or final identity before probes', async () => {
    const fixture = await signedFixture()
    let calls = 0
    const common = {
      runtimeRoot: fixture.finalRuntimeRoot,
      sourceIdentity: fixture.identity,
      finalIdentity: fixture.finalIdentity,
      selection: fixture.selection,
      spawnSyncImpl: () => {
        calls += 1
        throw new Error('must not spawn')
      }
    }
    try {
      await expect(
        verifySshRelayRuntimeWindowsSignatures({ ...common, platform: 'darwin' })
      ).rejects.toThrow(/requires Windows/i)

      const staleSelection = structuredClone(fixture.selection)
      staleSelection.signingFiles[0].sourceSha256 = `sha256:${'f'.repeat(64)}`
      await expect(
        verifySshRelayRuntimeWindowsSignatures({
          ...common,
          selection: staleSelection,
          platform: 'win32'
        })
      ).rejects.toThrow(/wrong source hash|selection and identity disagree/i)

      const staleArchive = structuredClone(fixture.finalIdentity)
      staleArchive.archive = { fileName: 'unsigned.zip' }
      await expect(
        verifySshRelayRuntimeWindowsSignatures({
          ...common,
          finalIdentity: staleArchive,
          platform: 'win32'
        })
      ).rejects.toThrow(/does not match its unsigned source/i)
      expect(calls).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
