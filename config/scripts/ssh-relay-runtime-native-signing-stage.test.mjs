import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import {
  parseSshRelayRuntimeNativeSigningStageArguments,
  prepareSshRelayRuntimeNativeSigningStage
} from './ssh-relay-runtime-native-signing-stage.mjs'
import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function platformForTuple(tupleId) {
  return tupleId.startsWith('linux-') ? 'linux' : tupleId.startsWith('darwin-') ? 'darwin' : 'win32'
}

async function runtimeFixture(tupleId) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-native-signing-stage-'))
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot)
  const entries = []
  for (const entry of expectedSshRelayRuntimeClosureEntries(tupleId)) {
    if (entry.type === 'directory') {
      await mkdir(join(runtimeRoot, ...entry.path.split('/')), { recursive: true })
      entries.push(entry)
      continue
    }
    const bytes = Buffer.from(`fixture:${tupleId}:${entry.path}`)
    const filePath = join(runtimeRoot, ...entry.path.split('/'))
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, bytes, { mode: entry.mode })
    entries.push({ ...entry, size: bytes.length, sha256: digest(bytes) })
  }
  return {
    root,
    runtimeRoot,
    identity: {
      tupleId,
      os: platformForTuple(tupleId),
      nodeVersion: '24.18.0',
      dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
      entries
    }
  }
}

describe('SSH relay runtime native signing stage', () => {
  it('parses exactly one identity, runtime, and exclusive stage path', () => {
    const parsed = parseSshRelayRuntimeNativeSigningStageArguments([
      '--identity',
      './identity.json',
      '--runtime-directory',
      './runtime',
      '--staging-directory',
      './stage'
    ])
    expect(parsed.identityPath).toMatch(/identity[.]json$/)
    expect(parsed.runtimeRoot).toMatch(/runtime$/)
    expect(parsed.stagingRoot).toMatch(/stage$/)
    expect(() => parseSshRelayRuntimeNativeSigningStageArguments([])).toThrow(/missing required/i)
    expect(() =>
      parseSshRelayRuntimeNativeSigningStageArguments([
        '--identity',
        'a',
        '--identity',
        'b',
        '--runtime-directory',
        'runtime',
        '--staging-directory',
        'stage'
      ])
    ).toThrow(/duplicate/i)
    expect(() => parseSshRelayRuntimeNativeSigningStageArguments(['--unknown', 'value'])).toThrow(
      /unknown/i
    )
  })

  it('authenticates Linux candidates without assessment or staging', async () => {
    const fixture = await runtimeFixture('linux-arm64-glibc')
    let assessmentCalls = 0
    try {
      const stagingRoot = join(fixture.root, 'stage')
      const report = await prepareSshRelayRuntimeNativeSigningStage({
        identity: fixture.identity,
        runtimeRoot: fixture.runtimeRoot,
        stagingRoot,
        platform: 'linux',
        assessWindowsImpl: async () => {
          assessmentCalls += 1
          return []
        }
      })

      expect(report).toEqual(
        expect.objectContaining({
          tupleId: 'linux-arm64-glibc',
          platform: 'linux',
          policy: 'linux-hash-only-v1',
          assessments: [],
          signingFiles: [],
          preservedUpstreamFiles: [],
          payload: expect.objectContaining({ stagingRequired: false, stagedFiles: [] })
        })
      )
      expect(assessmentCalls).toBe(0)
      await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('stages every macOS signing candidate without assessment', async () => {
    const fixture = await runtimeFixture('darwin-x64')
    try {
      const stagingRoot = join(fixture.root, 'stage')
      const report = await prepareSshRelayRuntimeNativeSigningStage({
        identity: fixture.identity,
        runtimeRoot: fixture.runtimeRoot,
        stagingRoot,
        platform: 'darwin'
      })

      expect(report.assessments).toEqual([])
      expect(report.signingFiles).toHaveLength(3)
      expect(report.payload.stagedFiles).toHaveLength(3)
      await expect(lstat(join(stagingRoot, 'bin', 'node'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      for (const entry of report.payload.stagedFiles) {
        await expect(readFile(join(stagingRoot, ...entry.path.split('/')))).resolves.toEqual(
          await readFile(join(fixture.runtimeRoot, ...entry.path.split('/')))
        )
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('assesses Windows once and stages only unsigned exact candidates', async () => {
    const fixture = await runtimeFixture('win32-arm64')
    const preservedPath = 'node_modules/node-pty/build/Release/conpty/OpenConsole.exe'
    let assessmentCalls = 0
    try {
      const plan = buildSshRelayRuntimeNativeSigningPlan(fixture.identity)
      const assessments = plan.signingCandidates.map((entry) =>
        entry.path === preservedPath
          ? {
              path: entry.path,
              sourceSha256: entry.sourceSha256,
              status: 'valid-upstream',
              signerSubject: 'CN=Microsoft Corporation',
              signerThumbprint: 'C'.repeat(40)
            }
          : { path: entry.path, sourceSha256: entry.sourceSha256, status: 'unsigned' }
      )
      const stagingRoot = join(fixture.root, 'stage')
      const report = await prepareSshRelayRuntimeNativeSigningStage({
        identity: fixture.identity,
        runtimeRoot: fixture.runtimeRoot,
        stagingRoot,
        platform: 'win32',
        assessWindowsImpl: async (options) => {
          assessmentCalls += 1
          expect(options).toEqual(
            expect.objectContaining({
              identity: fixture.identity,
              runtimeRoot: fixture.runtimeRoot
            })
          )
          return assessments
        }
      })

      expect(assessmentCalls).toBe(1)
      expect(report.assessments).toHaveLength(5)
      expect(report.signingFiles).toHaveLength(4)
      expect(report.preservedUpstreamFiles).toEqual([
        expect.objectContaining({ path: preservedPath, signerThumbprint: 'C'.repeat(40) })
      ])
      expect(report.payload.stagedFiles).toHaveLength(4)
      await expect(lstat(join(stagingRoot, ...preservedPath.split('/')))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects cross-host execution before assessment or staging', async () => {
    const fixture = await runtimeFixture('win32-x64')
    let assessmentCalls = 0
    try {
      const stagingRoot = join(fixture.root, 'stage')
      await expect(
        prepareSshRelayRuntimeNativeSigningStage({
          identity: fixture.identity,
          runtimeRoot: fixture.runtimeRoot,
          stagingRoot,
          platform: 'linux',
          assessWindowsImpl: async () => {
            assessmentCalls += 1
            return []
          }
        })
      ).rejects.toThrow(/target-native host/i)
      expect(assessmentCalls).toBe(0)
      await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
