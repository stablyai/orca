import { createHash } from 'node:crypto'
import {
  appendFile,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import {
  applySshRelayRuntimeNativeSigningReturn,
  assertSshRelayRuntimeNativeSigningApplyRoots
} from './ssh-relay-runtime-native-signing-apply.mjs'
import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'
import { buildSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function platformForTuple(tupleId) {
  return tupleId.startsWith('linux-') ? 'linux' : tupleId.startsWith('darwin-') ? 'darwin' : 'win32'
}

async function runtimeFixture(tupleId) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-native-signing-apply-'))
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot)
  const entries = []
  for (const entry of expectedSshRelayRuntimeClosureEntries(tupleId)) {
    if (entry.type === 'directory') {
      await mkdir(join(runtimeRoot, ...entry.path.split('/')), {
        recursive: true,
        mode: entry.mode
      })
      entries.push(entry)
      continue
    }
    const bytes = Buffer.from(`fixture:${tupleId}:${entry.path}`)
    const filePath = join(runtimeRoot, ...entry.path.split('/'))
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, bytes, { mode: entry.mode })
    entries.push({ ...entry, size: bytes.length, sha256: digest(bytes) })
  }
  const os = platformForTuple(tupleId)
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
  return {
    root,
    runtimeRoot,
    identity: {
      ...base,
      archive: {
        fileName: `orca-relay-runtime-${tupleId}.fixture`,
        size: 1,
        sha256: digest('stale-unsigned-archive')
      },
      contentId: computeSshRelayRuntimeContentId(base),
      fileCount: files.length,
      expandedSize: files.reduce((total, entry) => total + entry.size, 0)
    }
  }
}

function selectionFor(identity) {
  if (identity.os !== 'win32') {
    return buildSshRelayRuntimeNativeSigningSelection(identity, [])
  }
  const preserved = new Set([
    'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
    'node_modules/node-pty/build/Release/conpty/conpty.dll'
  ])
  const assessments = buildSshRelayRuntimeNativeSigningPlan(identity).signingCandidates.map(
    (entry) =>
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
  return buildSshRelayRuntimeNativeSigningSelection(identity, assessments)
}

async function returnedTree(fixture, selection) {
  const root = join(fixture.root, 'returned')
  for (const entry of selection.signingFiles) {
    const source = join(fixture.runtimeRoot, ...entry.path.split('/'))
    const destination = join(root, ...entry.path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination)
    await appendFile(destination, ':signed')
  }
  return root
}

describe('SSH relay runtime native signing return application', () => {
  it('applies only exact returned files into a new full runtime and derives final identity', async () => {
    for (const tupleId of ['darwin-arm64', 'win32-x64']) {
      const fixture = await runtimeFixture(tupleId)
      try {
        const selection = selectionFor(fixture.identity)
        const returnedRoot = await returnedTree(fixture, selection)
        const outputRuntimeRoot = join(fixture.root, 'final-runtime')
        const originalIdentity = structuredClone(fixture.identity)
        const nodePath = fixture.identity.os === 'win32' ? 'bin/node.exe' : 'bin/node'
        const sourceNode = await readFile(join(fixture.runtimeRoot, ...nodePath.split('/')))
        const sourceSigningBytes = new Map()
        for (const entry of selection.signingFiles) {
          sourceSigningBytes.set(
            entry.path,
            await readFile(join(fixture.runtimeRoot, ...entry.path.split('/')))
          )
        }

        const result = await applySshRelayRuntimeNativeSigningReturn({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot,
          outputRuntimeRoot,
          identity: fixture.identity,
          selection
        })

        expect(fixture.identity).toEqual(originalIdentity)
        expect(result.identity.contentId).not.toBe(fixture.identity.contentId)
        expect(result.identity).not.toHaveProperty('archive')
        expect(result.identity.fileCount).toBe(fixture.identity.fileCount)
        expect(result.returnedFiles).toHaveLength(selection.signingFiles.length)
        expect(await readFile(join(outputRuntimeRoot, ...nodePath.split('/')))).toEqual(sourceNode)
        expect(result.identity.entries.find((entry) => entry.path === nodePath)).toEqual(
          fixture.identity.entries.find((entry) => entry.path === nodePath)
        )
        for (const returned of result.returnedFiles) {
          const finalEntry = result.identity.entries.find((entry) => entry.path === returned.path)
          expect(finalEntry).toEqual(
            expect.objectContaining({ size: returned.signedSize, sha256: returned.signedSha256 })
          )
          expect(await readFile(join(outputRuntimeRoot, ...returned.path.split('/')))).toEqual(
            await readFile(join(returnedRoot, ...returned.path.split('/')))
          )
          expect(await readFile(join(fixture.runtimeRoot, ...returned.path.split('/')))).toEqual(
            sourceSigningBytes.get(returned.path)
          )
        }
        for (const preserved of selection.preservedUpstreamFiles) {
          expect(await readFile(join(outputRuntimeRoot, ...preserved.path.split('/')))).toEqual(
            await readFile(join(fixture.runtimeRoot, ...preserved.path.split('/')))
          )
          expect(result.identity.entries.find((entry) => entry.path === preserved.path)).toEqual(
            fixture.identity.entries.find((entry) => entry.path === preserved.path)
          )
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
  })

  it('rejects existing, source-nested, returned-nested, or overlapping roots', async () => {
    const fixture = await runtimeFixture('darwin-x64')
    try {
      const selection = selectionFor(fixture.identity)
      const returnedRoot = await returnedTree(fixture, selection)
      const existing = join(fixture.root, 'existing')
      await mkdir(existing)
      await expect(
        assertSshRelayRuntimeNativeSigningApplyRoots({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot,
          outputRuntimeRoot: existing
        })
      ).rejects.toThrow(/exclusive/i)
      await expect(
        assertSshRelayRuntimeNativeSigningApplyRoots({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot,
          outputRuntimeRoot: join(fixture.runtimeRoot, 'nested')
        })
      ).rejects.toThrow(/disjoint/i)
      await expect(
        assertSshRelayRuntimeNativeSigningApplyRoots({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot,
          outputRuntimeRoot: join(returnedRoot, 'nested')
        })
      ).rejects.toThrow(/disjoint/i)
      await expect(
        assertSshRelayRuntimeNativeSigningApplyRoots({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot: fixture.runtimeRoot,
          outputRuntimeRoot: join(fixture.root, 'output')
        })
      ).rejects.toThrow(/disjoint/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('removes the complete output if returned bytes change after initial verification', async () => {
    const fixture = await runtimeFixture('darwin-arm64')
    try {
      const selection = selectionFor(fixture.identity)
      const returnedRoot = await returnedTree(fixture, selection)
      const outputRuntimeRoot = join(fixture.root, 'final-runtime')
      const first = selection.signingFiles[0]
      const firstReturnedSuffix = join(...first.path.split('/'))
      let raced = false
      await expect(
        applySshRelayRuntimeNativeSigningReturn({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot,
          outputRuntimeRoot,
          identity: fixture.identity,
          selection,
          copyFileImpl: async (source, destination, mode) => {
            if (!raced && source.endsWith(firstReturnedSuffix)) {
              raced = true
              await appendFile(source, ':raced')
            }
            await copyFile(source, destination, mode)
          }
        })
      ).rejects.toThrow(/integrity mismatch/i)
      await expect(lstat(outputRuntimeRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects Linux and a mismatched selection before creating output', async () => {
    const fixture = await runtimeFixture('linux-x64-glibc')
    try {
      const outputRuntimeRoot = join(fixture.root, 'final-runtime')
      await expect(
        applySshRelayRuntimeNativeSigningReturn({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot: join(fixture.root, 'missing-return'),
          outputRuntimeRoot,
          identity: fixture.identity,
          selection: selectionFor(fixture.identity)
        })
      ).rejects.toThrow(/no signing files/i)
      await expect(lstat(outputRuntimeRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a selection whose authenticated source bytes disagree with the identity', async () => {
    const fixture = await runtimeFixture('darwin-x64')
    try {
      const selection = selectionFor(fixture.identity)
      selection.signingFiles[0].sourceSha256 = `sha256:${'f'.repeat(64)}`
      const outputRuntimeRoot = join(fixture.root, 'final-runtime')
      await expect(
        applySshRelayRuntimeNativeSigningReturn({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot: join(fixture.root, 'missing-return'),
          outputRuntimeRoot,
          identity: fixture.identity,
          selection
        })
      ).rejects.toThrow(/selection and identity disagree/i)
      await expect(lstat(outputRuntimeRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('removes the output if unsigned source bytes change during the copy', async () => {
    const fixture = await runtimeFixture('win32-x64')
    try {
      const selection = selectionFor(fixture.identity)
      const returnedRoot = await returnedTree(fixture, selection)
      const outputRuntimeRoot = join(fixture.root, 'final-runtime')
      const nodeSuffix = join('bin', 'node.exe')
      let raced = false
      await expect(
        applySshRelayRuntimeNativeSigningReturn({
          sourceRuntimeRoot: fixture.runtimeRoot,
          returnedRoot,
          outputRuntimeRoot,
          identity: fixture.identity,
          selection,
          copyFileImpl: async (source, destination, mode) => {
            if (!raced && source.endsWith(nodeSuffix)) {
              raced = true
              await appendFile(source, ':raced')
            }
            await copyFile(source, destination, mode)
          }
        })
      ).rejects.toThrow(/integrity mismatch/i)
      await expect(lstat(outputRuntimeRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
