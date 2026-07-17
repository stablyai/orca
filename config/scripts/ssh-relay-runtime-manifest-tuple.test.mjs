import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createSshRelayRuntimeArchive } from './ssh-relay-runtime-archive.mjs'
import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import {
  SSH_RELAY_RUNTIME_MANIFEST_TUPLE_LIMITS,
  createSshRelayRuntimeManifestNativeVerification,
  writeSshRelayRuntimeManifestTupleDescriptor
} from './ssh-relay-runtime-manifest-tuple.mjs'
import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'
import { createSshRelayRuntimeProvenance } from './ssh-relay-runtime-provenance.mjs'
import { createSshRelayRuntimeSbom } from './ssh-relay-runtime-sbom.mjs'

const temporaryDirectories = []
const SOURCE_DATE_EPOCH = 1_788_739_200
const VERIFIED_AT = '2026-07-15T00:00:00.000Z'

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-manifest-tuple-'))
  temporaryDirectories.push(root)
  const runtimeRoot = join(root, 'runtime')
  const inputDirectory = join(root, 'aggregate-input')
  await Promise.all([mkdir(runtimeRoot), mkdir(inputDirectory)])
  const entries = []
  for (const entry of expectedSshRelayRuntimeClosureEntries('win32-x64')) {
    const path = join(runtimeRoot, ...entry.path.split('/'))
    if (entry.type === 'directory') {
      await mkdir(path, { recursive: true, mode: entry.mode })
      entries.push(entry)
      continue
    }
    const bytes = Buffer.from(`final signed fixture:${entry.path}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { mode: entry.mode })
    entries.push({ ...entry, size: bytes.length, sha256: sha256(bytes) })
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
  const finalIdentity = {
    ...base,
    contentId: computeSshRelayRuntimeContentId(base),
    fileCount: files.length,
    expandedSize: files.reduce((total, entry) => total + entry.size, 0)
  }
  const archive = await createSshRelayRuntimeArchive({
    runtimeRoot,
    outputDirectory: inputDirectory,
    identity: finalIdentity,
    sourceDateEpoch: SOURCE_DATE_EPOCH
  })
  const sbomName = 'orca-ssh-relay-runtime-win32-x64.spdx.json'
  const provenanceName = 'orca-ssh-relay-runtime-win32-x64.provenance.json'
  const sbom = createSshRelayRuntimeSbom({
    identity: finalIdentity,
    archive,
    sourceDateEpoch: SOURCE_DATE_EPOCH
  })
  const toolchain = Object.fromEntries(
    [
      'buildNode',
      'bundledNode',
      'compiler',
      'buildSystem',
      'python',
      'archive',
      'linker',
      'nodeAddonApi',
      'nodeGyp'
    ].map((name, index) => [
      name,
      { version: `${name} version`, sha256: `sha256:${(index + 1).toString(16).repeat(64)}` }
    ])
  )
  const provenance = createSshRelayRuntimeProvenance({
    identity: finalIdentity,
    archive,
    nodeRelease: {
      baseUrl: 'https://nodejs.org/dist/v24.18.0',
      archives: {
        'win32-x64': { name: 'node-v24.18.0-win-x64.zip', sha256: 'a'.repeat(64) }
      },
      signature: {
        key: { sourceUrl: 'https://example.invalid/key.asc', sha256: 'b'.repeat(64) }
      },
      windowsBuildInputs: {
        headersArchive: { name: 'node-v24.18.0-headers.tar.gz', sha256: 'c'.repeat(64) },
        importLibraries: {
          'win32-x64': { name: 'win-x64/node.lib', sha256: 'd'.repeat(64) }
        }
      }
    },
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    gitCommit: '1'.repeat(40),
    builder: 'local://win32/x64',
    runner: {
      os: 'Windows',
      architecture: 'X64',
      environment: 'local',
      requestedLabel: 'local',
      image: { os: 'win32', version: 'local' }
    },
    toolchain
  })
  await Promise.all([
    writeFile(join(inputDirectory, sbomName), `${JSON.stringify(sbom)}\n`),
    writeFile(join(inputDirectory, provenanceName), `${JSON.stringify(provenance)}\n`)
  ])
  const plan = buildSshRelayRuntimeNativeSigningPlan(finalIdentity)
  return {
    root,
    runtimeRoot,
    inputDirectory,
    finalIdentity,
    archive,
    descriptorName: 'orca-ssh-relay-runtime-win32-x64.manifest-tuple.json',
    verificationReport: {
      tupleId: finalIdentity.tupleId,
      sourceContentId: `sha256:${'f'.repeat(64)}`,
      finalContentId: finalIdentity.contentId,
      verifiedFiles: plan.verificationFiles.map((entry) => ({
        path: entry.path,
        role: entry.role,
        sha256: entry.sourceSha256,
        signerKind: entry.role === 'node' ? 'official-node' : 'orca-built',
        signerSubject: entry.role === 'node' ? 'CN=OpenJS Foundation' : 'CN=SignPath Foundation',
        signerThumbprint: entry.role === 'node' ? 'A'.repeat(40) : 'F'.repeat(40)
      }))
    },
    nativeVerificationTool: { name: 'pwsh', version: '7.4.6' },
    verifiedAt: VERIFIED_AT
  }
}

function producerInput(fixture) {
  return {
    runtimeRoot: fixture.runtimeRoot,
    inputDirectory: fixture.inputDirectory,
    finalIdentity: fixture.finalIdentity,
    verificationReport: fixture.verificationReport,
    nativeVerificationTool: fixture.nativeVerificationTool,
    verifiedAt: fixture.verifiedAt
  }
}

function identityForTuple(tupleId) {
  const os = tupleId.startsWith('linux-')
    ? 'linux'
    : tupleId.startsWith('darwin-')
      ? 'darwin'
      : 'win32'
  const architecture = tupleId.endsWith('arm64') ? 'arm64' : 'x64'
  const entries = expectedSshRelayRuntimeClosureEntries(tupleId).map((entry) => {
    if (entry.type === 'directory') {
      return entry
    }
    const bytes = Buffer.from(`identity fixture:${tupleId}:${entry.path}`)
    return { ...entry, size: bytes.length, sha256: sha256(bytes) }
  })
  const base = {
    identitySchemaVersion: 1,
    tupleId,
    os,
    architecture,
    compatibility: sshRelayRuntimeCompatibility[tupleId],
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries
  }
  const files = entries.filter((entry) => entry.type === 'file')
  return {
    ...base,
    contentId: computeSshRelayRuntimeContentId(base),
    fileCount: files.length,
    expandedSize: files.reduce((total, entry) => total + entry.size, 0)
  }
}

function verificationReportFor(identity) {
  const plan = buildSshRelayRuntimeNativeSigningPlan(identity)
  return {
    tupleId: identity.tupleId,
    sourceContentId: plan.platform === 'linux' ? identity.contentId : `sha256:${'f'.repeat(64)}`,
    finalContentId: identity.contentId,
    verifiedFiles: plan.verificationFiles.map((entry) => {
      const base = { path: entry.path, role: entry.role, sha256: entry.sourceSha256 }
      if (plan.platform === 'darwin') {
        const officialNode = entry.role === 'node'
        return {
          ...base,
          signerKind: officialNode ? 'official-node' : 'orca-built',
          authority: officialNode
            ? 'Developer ID Application: Node.js Foundation'
            : 'Developer ID Application: Orca',
          teamIdentifier: officialNode ? 'HX7739G8FX' : 'ABCDEFGHIJ'
        }
      }
      return base
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

describe('SSH relay runtime post-sign manifest tuple', () => {
  it('writes one exact descriptor from the verified final tree and archive', async () => {
    const fixture = await runtimeFixture()

    const result = await writeSshRelayRuntimeManifestTupleDescriptor(producerInput(fixture))
    const descriptor = JSON.parse(
      await readFile(join(fixture.inputDirectory, fixture.descriptorName), 'utf8')
    )

    expect((await readdir(fixture.inputDirectory)).toSorted()).toEqual(
      [
        fixture.archive.name,
        'orca-ssh-relay-runtime-win32-x64.spdx.json',
        'orca-ssh-relay-runtime-win32-x64.provenance.json',
        fixture.descriptorName
      ].toSorted()
    )
    expect(descriptor).toEqual({ schemaVersion: 1, tuple: result.tuple })
    expect(result).toMatchObject({
      tupleId: 'win32-x64',
      tuple: {
        contentId: fixture.finalIdentity.contentId,
        archive: {
          name: fixture.archive.name,
          size: fixture.archive.size,
          sha256: fixture.archive.sha256
        },
        nativeVerification: {
          policy: 'signpath-authenticode-v1',
          tool: fixture.nativeVerificationTool,
          verifiedAt: VERIFIED_AT
        }
      },
      input: {
        tupleId: 'win32-x64',
        descriptor: { name: fixture.descriptorName },
        archive: {
          name: fixture.archive.name,
          size: fixture.archive.size,
          sha256: fixture.archive.sha256
        }
      }
    })
    expect(result.tuple.nativeVerification.files).toEqual(
      fixture.verificationReport.verifiedFiles
        .map(({ path, sha256: digest }) => ({ path, sha256: digest }))
        .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    )
  })

  it('rejects stale, incomplete, duplicate, or mismatched native verification reports', async () => {
    const stale = await runtimeFixture()
    stale.verificationReport.finalContentId = `sha256:${'e'.repeat(64)}`
    await expect(writeSshRelayRuntimeManifestTupleDescriptor(producerInput(stale))).rejects.toThrow(
      /verification.*content|content.*verification/i
    )

    const missing = await runtimeFixture()
    missing.verificationReport.verifiedFiles.pop()
    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor(producerInput(missing))
    ).rejects.toThrow(/native verification.*complete|missing/i)

    const duplicate = await runtimeFixture()
    duplicate.verificationReport.verifiedFiles.push({
      ...duplicate.verificationReport.verifiedFiles[0]
    })
    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor(producerInput(duplicate))
    ).rejects.toThrow(/duplicate|complete/i)

    const mismatched = await runtimeFixture()
    mismatched.verificationReport.verifiedFiles[0].sha256 = `sha256:${'d'.repeat(64)}`
    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor(producerInput(mismatched))
    ).rejects.toThrow(/native verification.*hash|mismatch/i)
  })

  it('rejects final-tree or archive mutation without leaving a descriptor', async () => {
    const tree = await runtimeFixture()
    await appendFile(join(tree.runtimeRoot, 'relay.js'), ':mutated')
    await expect(writeSshRelayRuntimeManifestTupleDescriptor(producerInput(tree))).rejects.toThrow(
      /tree.*integrity|integrity.*tree/i
    )
    await expect(readFile(join(tree.inputDirectory, tree.descriptorName))).rejects.toMatchObject({
      code: 'ENOENT'
    })

    const archive = await runtimeFixture()
    await writeFile(join(archive.inputDirectory, archive.archive.name), 'mutated archive')
    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor(producerInput(archive))
    ).rejects.toThrow(/archive|zip/i)
    await expect(
      readFile(join(archive.inputDirectory, archive.descriptorName))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects semantically stale post-sign metadata before writing a descriptor', async () => {
    const fixture = await runtimeFixture()
    const sbomPath = join(fixture.inputDirectory, 'orca-ssh-relay-runtime-win32-x64.spdx.json')
    const sbom = JSON.parse(await readFile(sbomPath, 'utf8'))
    sbom.packages.find((entry) => entry.name === 'orca-ssh-relay').versionInfo =
      `sha256:${'e'.repeat(64)}`
    await writeFile(sbomPath, `${JSON.stringify(sbom)}\n`)

    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor(producerInput(fixture))
    ).rejects.toThrow(/SBOM.*content|content.*SBOM/i)
    await expect(
      readFile(join(fixture.inputDirectory, fixture.descriptorName))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires an exclusive exact input set and bounded regular metadata', async () => {
    const extra = await runtimeFixture()
    await writeFile(join(extra.inputDirectory, 'unexpected.bin'), 'extra')
    await expect(writeSshRelayRuntimeManifestTupleDescriptor(producerInput(extra))).rejects.toThrow(
      /missing|unexpected|exact/i
    )

    const existing = await runtimeFixture()
    await writeFile(join(existing.inputDirectory, existing.descriptorName), 'stale')
    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor(producerInput(existing))
    ).rejects.toThrow(/exclusive|unexpected|exact/i)

    const oversized = await runtimeFixture()
    await truncate(
      join(oversized.inputDirectory, 'orca-ssh-relay-runtime-win32-x64.spdx.json'),
      SSH_RELAY_RUNTIME_MANIFEST_TUPLE_LIMITS.maximumMetadataBytes + 1
    )
    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor(producerInput(oversized))
    ).rejects.toThrow(/metadata|size|bounded/i)
  })

  it.skipIf(process.platform === 'win32')('rejects linked aggregate inputs', async () => {
    const fixture = await runtimeFixture()
    const sbom = join(fixture.inputDirectory, 'orca-ssh-relay-runtime-win32-x64.spdx.json')
    const target = join(fixture.root, 'linked-sbom')
    await writeFile(target, 'linked')
    await rm(sbom)
    const { symlink } = await import('node:fs/promises')
    await symlink(target, sbom)

    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor(producerInput(fixture))
    ).rejects.toThrow(/regular|unexpected|linked/i)
  })

  it('rejects malformed attestation metadata and honors cancellation', async () => {
    const tool = await runtimeFixture()
    tool.nativeVerificationTool.version = 'bad\nversion'
    await expect(writeSshRelayRuntimeManifestTupleDescriptor(producerInput(tool))).rejects.toThrow(
      /tool|version|native verification/i
    )

    const time = await runtimeFixture()
    time.verifiedAt = '2026-07-15T00:00:00Z'
    await expect(writeSshRelayRuntimeManifestTupleDescriptor(producerInput(time))).rejects.toThrow(
      /timestamp|verified|date/i
    )

    const cancelled = await runtimeFixture()
    const controller = new AbortController()
    controller.abort(new Error('cancel tuple descriptor'))
    await expect(
      writeSshRelayRuntimeManifestTupleDescriptor({
        ...producerInput(cancelled),
        signal: controller.signal
      })
    ).rejects.toThrow(/cancel tuple descriptor/i)
  })

  it('derives Linux and macOS native policies from their complete verifier reports', () => {
    const linux = identityForTuple('linux-arm64-glibc')
    const macos = identityForTuple('darwin-arm64')
    const common = { tool: { name: 'node', version: '24.18.0' }, verifiedAt: VERIFIED_AT }

    const linuxVerification = createSshRelayRuntimeManifestNativeVerification({
      ...common,
      identity: linux,
      report: verificationReportFor(linux)
    })
    expect(linuxVerification.policy).toBe('linux-hash-only-v1')
    expect(linuxVerification.files).toHaveLength(3)
    const macosReport = verificationReportFor(macos)
    const macosVerification = createSshRelayRuntimeManifestNativeVerification({
      ...common,
      identity: macos,
      report: macosReport
    })
    expect(macosVerification.policy).toBe('apple-developer-id-v1')
    expect(macosVerification.files).toHaveLength(4)

    delete macosReport.verifiedFiles[0].teamIdentifier
    expect(() =>
      createSshRelayRuntimeManifestNativeVerification({
        ...common,
        identity: macos,
        report: macosReport
      })
    ).toThrow(/macOS.*incomplete/i)
  })
})
