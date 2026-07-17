import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { finalizeSshRelayRuntimeNativeSigning } from './ssh-relay-runtime-native-signing-finalization.mjs'
import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'
import { prepareSshRelayRuntimeNativeSigningStage } from './ssh-relay-runtime-native-signing-stage.mjs'
import { parseSshRelayRuntimeNativeSigningStageReport } from './ssh-relay-runtime-native-signing-stage-report.mjs'

const temporaryDirectories = []
const SOURCE_DATE_EPOCH = 1_788_739_200
const GIT_COMMIT = '1'.repeat(40)

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function toolchain(tupleId) {
  const platformTool = tupleId.startsWith('win32-') ? 'linker' : 'strip'
  return Object.fromEntries(
    [
      'buildNode',
      'bundledNode',
      'compiler',
      'buildSystem',
      'python',
      'archive',
      'nodeAddonApi',
      'nodeGyp',
      platformTool
    ].map((name, index) => [
      name,
      { version: `${name} fixture`, sha256: `sha256:${(index + 1).toString(16).repeat(64)}` }
    ])
  )
}

async function fixture(
  tupleId = process.platform === 'win32' ? `win32-${process.arch}` : 'darwin-arm64'
) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-signing-finalization-'))
  temporaryDirectories.push(root)
  const sourceRuntimeRoot = join(root, 'source-runtime')
  await mkdir(sourceRuntimeRoot)
  const entries = []
  // Why: Windows finalization must create a ZIP because NTFS cannot supply POSIX tar modes.
  const os = tupleId.startsWith('win32-') ? 'win32' : 'darwin'
  for (const entry of expectedSshRelayRuntimeClosureEntries(tupleId)) {
    const path = join(sourceRuntimeRoot, ...entry.path.split('/'))
    if (entry.type === 'directory') {
      await mkdir(path, { recursive: true, mode: entry.mode })
      entries.push(entry)
      continue
    }
    const bytes = Buffer.from(`native finalization fixture:${entry.path}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { mode: entry.mode })
    entries.push({ ...entry, size: bytes.length, sha256: digest(bytes) })
  }
  const base = {
    identitySchemaVersion: 1,
    tupleId,
    os,
    architecture: tupleId.includes('arm64') ? 'arm64' : 'x64',
    compatibility: sshRelayRuntimeCompatibility[tupleId],
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries
  }
  const files = entries.filter((entry) => entry.type === 'file')
  const sourceIdentity = {
    ...base,
    contentId: computeSshRelayRuntimeContentId(base),
    fileCount: files.length,
    expandedSize: files.reduce((total, entry) => total + entry.size, 0)
  }
  const returnedRoot = join(root, 'returned')
  const preserved = new Set([
    'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
    'node_modules/node-pty/build/Release/conpty/conpty.dll'
  ])
  const assessments =
    os === 'win32'
      ? buildSshRelayRuntimeNativeSigningPlan(sourceIdentity).signingCandidates.map((entry) =>
          preserved.has(entry.path)
            ? {
                path: entry.path,
                sourceSha256: entry.sourceSha256,
                status: 'valid-upstream',
                signerSubject: 'CN=Microsoft Corporation',
                signerThumbprint: 'D'.repeat(40)
              }
            : { path: entry.path, sourceSha256: entry.sourceSha256, status: 'unsigned' }
        )
      : []
  const report = await prepareSshRelayRuntimeNativeSigningStage({
    identity: sourceIdentity,
    runtimeRoot: sourceRuntimeRoot,
    stagingRoot: returnedRoot,
    platform: os,
    assessWindowsImpl: async () => assessments
  })
  for (const entry of report.signingFiles) {
    await appendFile(join(returnedRoot, ...entry.path.split('/')), ':signed')
  }
  const nodeRelease = JSON.parse(
    await readFile(new URL('../ssh-relay-node-release-v24.18.0.json', import.meta.url), 'utf8')
  )
  const { selection } = parseSshRelayRuntimeNativeSigningStageReport(sourceIdentity, report)
  return { root, tupleId, sourceRuntimeRoot, returnedRoot, sourceIdentity, selection, nodeRelease }
}

function nativeReport(sourceIdentity, finalIdentity, selection) {
  const finalFiles = new Map(
    finalIdentity.entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => [entry.path, entry])
  )
  const immutable = new Set(selection.immutableVendorFiles.map((entry) => entry.path))
  const signing = new Set(selection.signingFiles.map((entry) => entry.path))
  return {
    tupleId: finalIdentity.tupleId,
    sourceContentId: sourceIdentity.contentId,
    finalContentId: finalIdentity.contentId,
    verifiedFiles: selection.verificationFiles.map((entry) => {
      const signerKind = immutable.has(entry.path)
        ? 'official-node'
        : signing.has(entry.path)
          ? 'orca-built'
          : 'preserved-upstream'
      const base = {
        path: entry.path,
        role: entry.role,
        sha256: finalFiles.get(entry.path).sha256,
        signerKind
      }
      return sourceIdentity.os === 'win32'
        ? {
            ...base,
            signerSubject:
              signerKind === 'official-node'
                ? 'CN=OpenJS Foundation'
                : signerKind === 'orca-built'
                  ? 'CN=SignPath Foundation'
                  : 'CN=Microsoft Corporation',
            signerThumbprint: (signerKind === 'preserved-upstream' ? 'D' : 'A').repeat(40)
          }
        : {
            ...base,
            authority: `Developer ID Application: Fixture (${signerKind === 'official-node' ? 'HX7739G8FX' : 'ABCDEFGHIJ'})`,
            teamIdentifier: signerKind === 'official-node' ? 'HX7739G8FX' : 'ABCDEFGHIJ'
          }
    })
  }
}

function finalizationInput(value, outputDirectory) {
  return {
    ...value,
    outputDirectory,
    expectedOrcaTeamIdentifier: 'ABCDEFGHIJ',
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    gitCommit: GIT_COMMIT,
    builder: 'https://github.com/stablyai/orca/ssh-relay-runtime-native-signing-fixture',
    runner: {
      os: value.sourceIdentity.os === 'win32' ? 'Windows' : 'macOS',
      architecture: value.sourceIdentity.architecture.toUpperCase(),
      environment: 'fixture',
      requestedLabel: value.sourceIdentity.os === 'win32' ? 'windows-fixture' : 'macos-15',
      image: { os: value.sourceIdentity.os, version: 'fixture' }
    },
    toolchain: toolchain(value.tupleId),
    nativeVerificationTool: {
      name: value.sourceIdentity.os === 'win32' ? 'Get-AuthenticodeSignature' : 'codesign',
      version: 'fixture-v1'
    },
    verifiedAt: '2026-07-15T12:00:00.000Z',
    verifyNativeImpl: ({ sourceIdentity, finalIdentity, selection }) =>
      nativeReport(sourceIdentity, finalIdentity, selection),
    smokeImpl: async () => ({
      tree: { verified: true },
      smoke: { nodeVersion: 'v24.18.0', pty: 'passed', watcher: 'passed' }
    })
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay runtime native signing finalization', () => {
  it('emits only final signed-byte assets after native verification and smoke', async () => {
    const tuples =
      process.platform === 'win32' ? [`win32-${process.arch}`] : ['darwin-arm64', 'win32-x64']
    for (const tupleId of tuples) {
      const value = await fixture(tupleId)
      const outputDirectory = join(value.root, 'final')
      const result = await finalizeSshRelayRuntimeNativeSigning(
        finalizationInput(value, outputDirectory)
      )

      expect(result.finalContentId).not.toBe(value.sourceIdentity.contentId)
      expect(result.returnedFiles).toHaveLength(3)
      expect(await readdir(result.assetsRoot)).toHaveLength(4)
      expect(
        (await readdir(result.assetsRoot)).some((name) => name.endsWith('.manifest-tuple.json'))
      ).toBe(true)
      expect(await readdir(result.evidenceRoot)).toEqual(
        expect.arrayContaining([
          `${value.tupleId}.final-identity.json`,
          `${value.tupleId}.finalization.json`,
          `${value.tupleId}.native-verification.json`
        ])
      )
    }
  })

  it('removes the complete output when native trust fails', async () => {
    const value = await fixture()
    const outputDirectory = join(value.root, 'rejected')
    const input = finalizationInput(value, outputDirectory)
    input.verifyNativeImpl = async () => {
      throw new Error('fixture native trust denied')
    }
    await expect(finalizeSshRelayRuntimeNativeSigning(input)).rejects.toThrow(/trust denied/i)
    await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
