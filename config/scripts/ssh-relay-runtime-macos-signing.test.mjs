import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { signSshRelayRuntimeMacosPayload } from './ssh-relay-runtime-macos-signing.mjs'
import { prepareSshRelayRuntimeNativeSigningStage } from './ssh-relay-runtime-native-signing-stage.mjs'
import { parseSshRelayRuntimeNativeSigningStageReport } from './ssh-relay-runtime-native-signing-stage-report.mjs'

const temporaryDirectories = []

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-macos-signing-'))
  temporaryDirectories.push(root)
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot)
  const entries = []
  for (const entry of expectedSshRelayRuntimeClosureEntries('darwin-arm64')) {
    const path = join(runtimeRoot, ...entry.path.split('/'))
    if (entry.type === 'directory') {
      await mkdir(path, { recursive: true, mode: entry.mode })
      entries.push(entry)
      continue
    }
    const bytes = Buffer.from(`macOS signing fixture:${entry.path}`)
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
  const identity = {
    ...base,
    contentId: computeSshRelayRuntimeContentId(base),
    fileCount: files.length,
    expandedSize: files.reduce((total, entry) => total + entry.size, 0)
  }
  const stagingRoot = join(root, 'stage')
  const report = await prepareSshRelayRuntimeNativeSigningStage({
    identity,
    runtimeRoot,
    stagingRoot,
    platform: 'darwin'
  })
  return { identity, report, stagingRoot }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay runtime macOS signing boundary', () => {
  it('validates the hash-bound report and signs every exact staged file', async () => {
    const value = await fixture()
    const { selection } = parseSshRelayRuntimeNativeSigningStageReport(value.identity, value.report)
    const calls = []
    const result = await signSshRelayRuntimeMacosPayload({
      stagingRoot: value.stagingRoot,
      selection,
      signingIdentity: 'Developer ID Application: Orca Test (ABCDEFGHIJ)',
      platform: 'darwin',
      spawnSyncImpl: (command, args) => {
        calls.push({ command, args })
        appendFileSync(args.at(-1), ':signed')
        return { status: 0, stdout: '', stderr: '' }
      }
    })

    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.command === '/usr/bin/codesign')).toBe(true)
    expect(calls.every((call) => call.args.includes('--timestamp'))).toBe(true)
    expect(result.returnedFiles).toHaveLength(3)
  })

  it('rejects report drift and unchanged or failed signing commands', async () => {
    const drift = await fixture()
    drift.report.signingFiles[0].sourceSha256 = `sha256:${'0'.repeat(64)}`
    expect(() =>
      parseSshRelayRuntimeNativeSigningStageReport(drift.identity, drift.report)
    ).toThrow(/disagrees/i)

    const unchanged = await fixture()
    const { selection } = parseSshRelayRuntimeNativeSigningStageReport(
      unchanged.identity,
      unchanged.report
    )
    await expect(
      signSshRelayRuntimeMacosPayload({
        stagingRoot: unchanged.stagingRoot,
        selection,
        signingIdentity: 'Developer ID Application: Orca Test (ABCDEFGHIJ)',
        platform: 'darwin',
        spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' })
      })
    ).rejects.toThrow(/did not change/i)

    const failed = await fixture()
    const failedSelection = parseSshRelayRuntimeNativeSigningStageReport(
      failed.identity,
      failed.report
    ).selection
    await expect(
      signSshRelayRuntimeMacosPayload({
        stagingRoot: failed.stagingRoot,
        selection: failedSelection,
        signingIdentity: 'Developer ID Application: Orca Test (ABCDEFGHIJ)',
        platform: 'darwin',
        spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'denied' })
      })
    ).rejects.toThrow(/failed/i)
  })
})
