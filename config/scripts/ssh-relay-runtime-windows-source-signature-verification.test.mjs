import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'
import { buildSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'
import {
  parseSshRelayRuntimeWindowsSourceSignatureArguments,
  readSshRelayRuntimeWindowsSigningStageReport,
  selectionFromSshRelayRuntimeWindowsSigningStageReport,
  verifySshRelayRuntimeWindowsSourceSignatures
} from './ssh-relay-runtime-windows-source-signature-verification.mjs'
import { OFFICIAL_NODE_WINDOWS_SIGNER_SUBJECT } from './ssh-relay-runtime-windows-signature-verification.mjs'

const MICROSOFT_SUBJECT =
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-windows-source-signature-'))
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
  const identity = {
    ...base,
    contentId: computeSshRelayRuntimeContentId(base),
    fileCount: files.length,
    expandedSize: files.reduce((total, entry) => total + entry.size, 0)
  }
  const assessments = buildSshRelayRuntimeNativeSigningPlan(identity).signingCandidates.map(
    (entry, index) => {
      const preserved =
        entry.path.endsWith('/OpenConsole.exe') || entry.path.endsWith('/conpty.dll')
      return preserved
        ? {
            path: entry.path,
            sourceSha256: entry.sourceSha256,
            status: 'valid-upstream',
            signerSubject: MICROSOFT_SUBJECT,
            signerThumbprint: `${index + 1}`.repeat(40)
          }
        : { path: entry.path, sourceSha256: entry.sourceSha256, status: 'unsigned' }
    }
  )
  const selection = buildSshRelayRuntimeNativeSigningSelection(identity, assessments)
  const report = {
    tupleId: selection.tupleId,
    platform: selection.platform,
    policy: selection.policy,
    assessments,
    immutableVendorFiles: selection.immutableVendorFiles,
    signingFiles: selection.signingFiles,
    preservedUpstreamFiles: selection.preservedUpstreamFiles,
    payload: { stagingRequired: true }
  }
  const reportPath = join(root, 'signing-stage.json')
  await writeFile(reportPath, JSON.stringify(report))
  return { root, runtimeRoot, identity, assessments, selection, report, reportPath }
}

function entryForPath(selection, physicalPath) {
  return [...selection.immutableVendorFiles, ...selection.preservedUpstreamFiles].find((entry) =>
    physicalPath.endsWith(join(...entry.path.split('/')))
  )
}

function signatureJson(subject, thumbprint) {
  return JSON.stringify({ status: 'Valid', signerSubject: subject, signerThumbprint: thumbprint })
}

function successfulAuthenticode(selection, calls, override = () => undefined) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const entry = entryForPath(selection, options.env.ORCA_SSH_RELAY_AUTHENTICODE_FILE)
    const overridden = override(entry)
    if (overridden) {
      return { status: 0, stdout: JSON.stringify(overridden), stderr: '' }
    }
    return {
      status: 0,
      stdout:
        entry.action === 'preserve-exact-bytes'
          ? signatureJson(OFFICIAL_NODE_WINDOWS_SIGNER_SUBJECT, 'A'.repeat(40))
          : signatureJson(entry.signerSubject, entry.signerThumbprint),
      stderr: ''
    }
  }
}

describe('SSH relay runtime Windows source signature verification', () => {
  it('parses exact CLI arguments and authenticates the signing-stage report', async () => {
    expect(
      parseSshRelayRuntimeWindowsSourceSignatureArguments([
        '--identity',
        'identity.json',
        '--runtime-directory',
        'runtime',
        '--signing-report',
        'report.json'
      ])
    ).toEqual({
      identityPath: expect.stringMatching(/identity\.json$/u),
      runtimeRoot: expect.stringMatching(/runtime$/u),
      signingReportPath: expect.stringMatching(/report\.json$/u)
    })
    expect(() =>
      parseSshRelayRuntimeWindowsSourceSignatureArguments(['--identity', 'identity.json'])
    ).toThrow(/missing required/i)

    const fixture = await sourceFixture()
    try {
      const report = await readSshRelayRuntimeWindowsSigningStageReport(fixture.reportPath)
      expect(
        selectionFromSshRelayRuntimeWindowsSigningStageReport(fixture.identity, report)
      ).toEqual(fixture.selection)

      report.preservedUpstreamFiles[0].signerThumbprint = '0'.repeat(40)
      expect(() =>
        selectionFromSshRelayRuntimeWindowsSigningStageReport(fixture.identity, report)
      ).toThrow(/report and authenticated selection disagree/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('verifies the complete source tree before exact Node and preserved signer policy', async () => {
    const fixture = await sourceFixture()
    const calls = []
    try {
      const result = await verifySshRelayRuntimeWindowsSourceSignatures({
        runtimeRoot: fixture.runtimeRoot,
        identity: fixture.identity,
        selection: fixture.selection,
        platform: 'win32',
        spawnSyncImpl: successfulAuthenticode(fixture.selection, calls)
      })

      expect(result.tupleId).toBe('win32-x64')
      expect(result.verifiedFiles).toHaveLength(3)
      expect(result.verifiedFiles.map((entry) => entry.signerKind).sort()).toEqual([
        'official-node',
        'preserved-upstream',
        'preserved-upstream'
      ])
      expect(calls).toHaveLength(3)
      expect(calls.every((call) => call.command === 'pwsh')).toBe(true)
      expect(calls.every((call) => call.options.timeout === 30_000)).toBe(true)
      expect(calls.every((call) => call.options.maxBuffer === 64 * 1024)).toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects wrong Node or preserved signer policy and invalid status', async () => {
    const fixture = await sourceFixture()
    const common = {
      runtimeRoot: fixture.runtimeRoot,
      identity: fixture.identity,
      selection: fixture.selection,
      platform: 'win32'
    }
    try {
      await expect(
        verifySshRelayRuntimeWindowsSourceSignatures({
          ...common,
          spawnSyncImpl: successfulAuthenticode(fixture.selection, [], (entry) =>
            entry.action === 'preserve-exact-bytes'
              ? {
                  status: 'Valid',
                  signerSubject: 'CN=Unexpected Node',
                  signerThumbprint: 'A'.repeat(40)
                }
              : undefined
          )
        })
      ).rejects.toThrow(/official Node signer policy/i)
      await expect(
        verifySshRelayRuntimeWindowsSourceSignatures({
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
      await expect(
        verifySshRelayRuntimeWindowsSourceSignatures({
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
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects tree mutation before probing and source mutation during a probe', async () => {
    const fixture = await sourceFixture()
    let calls = 0
    try {
      await appendFile(join(fixture.runtimeRoot, 'relay.js'), ':mutated')
      await expect(
        verifySshRelayRuntimeWindowsSourceSignatures({
          runtimeRoot: fixture.runtimeRoot,
          identity: fixture.identity,
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

    const raced = await sourceFixture()
    try {
      const spawn = successfulAuthenticode(raced.selection, [])
      let mutated = false
      await expect(
        verifySshRelayRuntimeWindowsSourceSignatures({
          runtimeRoot: raced.runtimeRoot,
          identity: raced.identity,
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

  it('rejects cross-platform execution and stale preserved-signer evidence', async () => {
    const fixture = await sourceFixture()
    let calls = 0
    try {
      await expect(
        verifySshRelayRuntimeWindowsSourceSignatures({
          runtimeRoot: fixture.runtimeRoot,
          identity: fixture.identity,
          selection: fixture.selection,
          platform: 'linux',
          spawnSyncImpl: () => {
            calls += 1
            throw new Error('must not spawn')
          }
        })
      ).rejects.toThrow(/requires Windows/i)
      expect(calls).toBe(0)

      const stale = structuredClone(fixture.selection)
      stale.preservedUpstreamFiles[0].signerThumbprint = '0'.repeat(40)
      await expect(
        verifySshRelayRuntimeWindowsSourceSignatures({
          runtimeRoot: fixture.runtimeRoot,
          identity: fixture.identity,
          selection: stale,
          platform: 'win32',
          spawnSyncImpl: successfulAuthenticode(fixture.selection, [])
        })
      ).rejects.toThrow(/preserved upstream signer policy/i)
      expect(calls).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
