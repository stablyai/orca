import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { writeSshRelayRuntimeMetadata } from './ssh-relay-runtime-provenance.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const sha256 = (character) => `sha256:${character.repeat(64)}`

function file(path, role, character) {
  return { path, type: 'file', role, size: 1, mode: 0o644, sha256: sha256(character) }
}

function fixture() {
  const tuple = 'linux-x64-glibc'
  const identity = {
    tupleId: tuple,
    os: 'linux',
    architecture: 'x64',
    nodeVersion: '24.18.0',
    contentId: sha256('f'),
    fileCount: 5,
    expandedSize: 5,
    entries: [
      file('bin/node', 'node', '1'),
      file('relay.js', 'relay', '2'),
      file('node_modules/node-pty/build/Release/pty.node', 'node-pty-native', '3'),
      file(
        'node_modules/@parcel/watcher-linux-x64-glibc/watcher.node',
        'parcel-watcher-native',
        '4'
      ),
      file('THIRD_PARTY_LICENSES.txt', 'license', '5')
    ]
  }
  return {
    tuple,
    identity,
    archive: {
      name: `orca-ssh-relay-runtime-v1-${tuple}-${'f'.repeat(64)}.tar.br`,
      size: 123,
      sha256: sha256('a')
    },
    nodeRelease: {
      baseUrl: 'https://nodejs.org/dist/v24.18.0',
      archives: {
        [tuple]: { name: 'node-v24.18.0-linux-x64.tar.xz', sha256: 'b'.repeat(64) }
      },
      signature: {
        key: {
          sourceUrl: 'https://github.com/nodejs/release-keys/raw/commit/gpg/key.asc',
          sha256: 'c'.repeat(64)
        }
      }
    }
  }
}

describe('SSH relay runtime published metadata', () => {
  it('binds SPDX, SLSA provenance, and identity to the exact archive and runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-metadata-'))
    temporaryDirectories.push(outputDirectory)
    const input = fixture()
    const runner = {
      os: 'Linux',
      architecture: 'X64',
      environment: 'github-hosted',
      requestedLabel: 'ubuntu-24.04',
      image: { os: 'ubuntu24', version: '20260705.232.1' }
    }
    const toolchain = Object.fromEntries(
      [
        'buildNode',
        'bundledNode',
        'compiler',
        'buildSystem',
        'python',
        'archive',
        'nodeAddonApi',
        'nodeGyp',
        'strip'
      ].map((name, index) => [
        name,
        { version: `${name} version`, sha256: sha256((index + 6).toString(16)) }
      ])
    )
    const builder = `https://github.com/stablyai/orca/blob/${'1'.repeat(40)}/.github/workflows/ssh-relay-runtime-artifacts.yml`

    const assets = await writeSshRelayRuntimeMetadata({
      outputDirectory,
      identity: input.identity,
      archive: input.archive,
      nodeRelease: input.nodeRelease,
      sourceDateEpoch: 1_752_710_400,
      gitCommit: '1'.repeat(40),
      builder,
      runner,
      toolchain
    })
    const sbom = JSON.parse(await readFile(join(outputDirectory, assets.sbom.name), 'utf8'))
    const provenance = JSON.parse(
      await readFile(join(outputDirectory, assets.provenance.name), 'utf8')
    )
    const identity = JSON.parse(await readFile(join(outputDirectory, assets.identity.name), 'utf8'))

    expect(sbom.files).toHaveLength(input.identity.fileCount)
    expect(
      sbom.relationships.filter((entry) => entry.relationshipType === 'CONTAINS')
    ).toHaveLength(input.identity.fileCount)
    expect(provenance.subject).toEqual([
      { name: input.archive.name, digest: { sha256: 'a'.repeat(64) } }
    ])
    expect(provenance.predicate.runDetails).toMatchObject({
      builder: { id: builder },
      metadata: { runner }
    })
    expect(provenance.predicate.buildDefinition).toMatchObject({
      externalParameters: { contentId: input.identity.contentId },
      internalParameters: { toolchain },
      resolvedDependencies: expect.arrayContaining([
        {
          uri: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz',
          digest: { sha256: 'b'.repeat(64) }
        },
        {
          uri: `git+https://github.com/stablyai/orca@${'1'.repeat(40)}`,
          digest: { gitCommit: '1'.repeat(40) }
        }
      ])
    })
    expect(identity.archive).toEqual({
      name: input.archive.name,
      size: 123,
      expandedSize: 5,
      fileCount: 5,
      sha256: sha256('a')
    })
    await expect(
      writeSshRelayRuntimeMetadata({
        outputDirectory,
        identity: input.identity,
        archive: input.archive,
        nodeRelease: input.nodeRelease,
        sourceDateEpoch: 1_752_710_400,
        gitCommit: '1'.repeat(40),
        builder,
        runner,
        toolchain
      })
    ).rejects.toThrow()
  })
})
