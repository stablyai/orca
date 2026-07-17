import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSshRelayArtifactTestManifest } from '../../src/main/ssh/ssh-relay-artifact-test-manifest.ts'
import {
  finalizeSshRelayRuntimeLinuxArtifact,
  parseSshRelayRuntimeLinuxFinalizationArguments
} from './ssh-relay-runtime-linux-finalization.mjs'

const temporaryDirectories = []
const VERIFIED_AT = '2026-07-15T13:30:00.000Z'
const artifactWorkflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-artifacts.yml',
  import.meta.url
)

function linuxIdentity() {
  const tuple = createSshRelayArtifactTestManifest().tuples[0]
  const {
    archive,
    metadataAssets: _metadataAssets,
    nativeVerification: _native,
    ...identity
  } = tuple
  return { identity: { ...identity, archive }, finalIdentity: identity }
}

function linuxPlan(identity) {
  return {
    platform: 'linux',
    verificationFiles: identity.entries
      .filter(
        (entry) =>
          entry.type === 'file' &&
          ['node', 'node-pty-native', 'parcel-watcher-native', 'native-runtime'].includes(
            entry.role
          )
      )
      .map((entry) => ({ path: entry.path, role: entry.role, sourceSha256: entry.sha256 }))
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-runtime-linux-finalization-'))
  temporaryDirectories.push(root)
  const source = join(root, 'source')
  const runtime = join(source, 'runtime')
  const output = join(root, 'final')
  await mkdir(runtime, { recursive: true })
  const { identity, finalIdentity } = linuxIdentity()
  const identityPath = join(source, `orca-ssh-relay-runtime-${identity.tupleId}.identity.json`)
  const archivePath = join(source, identity.archive.name)
  const sbomPath = join(source, `orca-ssh-relay-runtime-${identity.tupleId}.spdx.json`)
  const provenancePath = join(source, `orca-ssh-relay-runtime-${identity.tupleId}.provenance.json`)
  await Promise.all([
    writeFile(identityPath, `${JSON.stringify(identity)}\n`),
    writeFile(archivePath, 'archive'),
    writeFile(sbomPath, 'sbom'),
    writeFile(provenancePath, 'provenance')
  ])
  return { source, runtime, output, identity, finalIdentity, identityPath }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay runtime Linux hash-only finalization', () => {
  it('verifies before emitting an exact aggregate-ready descriptor and receipt', async () => {
    const input = await fixture()
    const order = []
    const plan = linuxPlan(input.finalIdentity)
    const physicalIdentityPath = await realpath(input.identityPath)
    const physicalRuntime = await realpath(input.runtime)
    const physicalSource = await realpath(input.source)
    const verifyRuntimeImpl = vi.fn(async ({ runtimeDirectory, identityPath, archivePath }) => {
      order.push('verify')
      expect(runtimeDirectory).toBe(physicalRuntime)
      expect(identityPath).toBe(physicalIdentityPath)
      expect(archivePath).toBe(join(physicalSource, input.identity.archive.name))
      return { smoke: { nodeVersion: 'v24.18.0' } }
    })
    const writeDescriptorImpl = vi.fn(async (options) => {
      order.push('descriptor')
      expect(options.finalIdentity).toEqual(input.finalIdentity)
      expect(options.verificationReport).toEqual({
        tupleId: input.identity.tupleId,
        sourceContentId: input.identity.contentId,
        finalContentId: input.identity.contentId,
        verifiedFiles: plan.verificationFiles.map((file) => ({
          path: file.path,
          role: file.role,
          sha256: file.sourceSha256
        }))
      })
      expect(options.nativeVerificationTool).toEqual({ name: 'node', version: '24.18.0' })
      expect(options.verifiedAt).toBe(VERIFIED_AT)
      return {
        tupleId: input.identity.tupleId,
        input: {
          tupleId: input.identity.tupleId,
          descriptor: { name: 'descriptor.json', size: 1, sha256: `sha256:${'a'.repeat(64)}` },
          archive: {
            name: input.identity.archive.name,
            size: 7,
            sha256: `sha256:${'b'.repeat(64)}`
          },
          sbom: { name: 'sbom.json', size: 4, sha256: `sha256:${'c'.repeat(64)}` },
          provenance: { name: 'provenance.json', size: 10, sha256: `sha256:${'d'.repeat(64)}` }
        }
      }
    })

    const result = await finalizeSshRelayRuntimeLinuxArtifact({
      sourceOutputDirectory: input.source,
      identityPath: input.identityPath,
      outputDirectory: input.output,
      verifiedAt: VERIFIED_AT,
      nativeVerificationTool: { name: 'node', version: '24.18.0' },
      readIdentityImpl: async () => input.identity,
      buildPlanImpl: () => plan,
      verifyRuntimeImpl,
      writeDescriptorImpl
    })

    expect(order).toEqual(['verify', 'descriptor'])
    expect(result).toMatchObject({
      tupleId: input.identity.tupleId,
      contentId: input.identity.contentId,
      aggregateInput: { tupleId: input.identity.tupleId }
    })
    expect(JSON.parse(await readFile(result.receiptPath, 'utf8'))).toEqual({
      tupleId: input.identity.tupleId,
      contentId: input.identity.contentId,
      verification: { smoke: { nodeVersion: 'v24.18.0' } },
      aggregateInput: result.aggregateInput
    })
    await expect(
      readFile(join(result.assetsRoot, input.identity.archive.name), 'utf8')
    ).resolves.toBe('archive')
  })

  it('rejects non-Linux input and removes partial output on failure', async () => {
    const input = await fixture()
    const nonLinux = { ...input.identity, os: 'darwin', tupleId: 'darwin-x64' }
    await expect(
      finalizeSshRelayRuntimeLinuxArtifact({
        sourceOutputDirectory: input.source,
        identityPath: input.identityPath,
        outputDirectory: input.output,
        verifiedAt: VERIFIED_AT,
        nativeVerificationTool: { name: 'node', version: '24.18.0' },
        readIdentityImpl: async () => nonLinux,
        verifyRuntimeImpl: vi.fn(),
        writeDescriptorImpl: vi.fn()
      })
    ).rejects.toThrow(/linux/i)

    await expect(
      finalizeSshRelayRuntimeLinuxArtifact({
        sourceOutputDirectory: input.source,
        identityPath: input.identityPath,
        outputDirectory: input.output,
        verifiedAt: VERIFIED_AT,
        nativeVerificationTool: { name: 'node', version: '24.18.0' },
        readIdentityImpl: async () => input.identity,
        buildPlanImpl: () => linuxPlan(input.finalIdentity),
        verifyRuntimeImpl: async () => ({ smoke: true }),
        writeDescriptorImpl: async () => {
          throw new Error('descriptor failed')
        }
      })
    ).rejects.toThrow(/descriptor failed/i)
    await expect(
      readFile(join(input.output, 'assets', input.identity.archive.name))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('parses only the exact bounded CLI arguments', () => {
    expect(
      parseSshRelayRuntimeLinuxFinalizationArguments([
        '--source-output-directory',
        'source',
        '--identity',
        'identity.json',
        '--output-directory',
        'output',
        '--verified-at',
        VERIFIED_AT,
        '--native-verification-tool-version',
        '24.18.0'
      ])
    ).toMatchObject({
      verifiedAt: VERIFIED_AT,
      nativeVerificationToolVersion: '24.18.0'
    })
    expect(() =>
      parseSshRelayRuntimeLinuxFinalizationArguments(['--output-directory', 'output'])
    ).toThrow(/missing/i)
    expect(() =>
      parseSshRelayRuntimeLinuxFinalizationArguments([
        '--source-output-directory',
        'source',
        '--identity',
        'identity.json',
        '--output-directory',
        'output',
        '--verified-at',
        VERIFIED_AT,
        '--native-verification-tool-version',
        '24.18.0',
        '--extra',
        'value'
      ])
    ).toThrow(/invalid/i)
  })

  it('emits Linux descriptors before upload and runs the contract on both native families', async () => {
    const source = await readFile(artifactWorkflowUrl, 'utf8')
    const workflow = parse(source)
    const posix = workflow.jobs['build-posix-runtime']
    const windows = workflow.jobs['build-windows-runtime']
    const build = posix.steps.find(
      (step) => step.name === 'Build twice, inspect, smoke, and compare exact runtime'
    ).run
    const finalization = build.indexOf('ssh-relay-runtime-linux-finalization.mjs')
    const descriptorCopy = build.indexOf('.manifest-tuple.json', finalization)
    const linuxExit = build.indexOf('exit 0', descriptorCopy)
    expect(finalization).toBeGreaterThan(-1)
    expect(descriptorCopy).toBeGreaterThan(finalization)
    expect(linuxExit).toBeGreaterThan(descriptorCopy)
    for (const job of [posix, windows]) {
      const contract = job.steps.find(
        (step) => step.name === 'Run runtime artifact contract tests'
      ).run
      expect(contract).toContain(
        'node --check config/scripts/ssh-relay-runtime-linux-finalization.mjs'
      )
      expect(contract).toContain('config/scripts/ssh-relay-runtime-linux-finalization.test.mjs')
    }
    expect(posix.steps.at(-1).with.path).toBe('runtime-evidence/${{ matrix.tuple }}/')
  })
})
