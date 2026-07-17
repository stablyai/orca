import { createHash } from 'node:crypto'
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import {
  stageSshRelayRuntimeNativeSigningPayload,
  verifySshRelayRuntimeNativeSigningReturn
} from './ssh-relay-runtime-native-signing-payload.mjs'
import { buildSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function platformForTuple(tupleId) {
  return tupleId.startsWith('linux-') ? 'linux' : tupleId.startsWith('darwin-') ? 'darwin' : 'win32'
}

async function runtimeFixture(tupleId) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-native-signing-payload-'))
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

function windowsAssessments(identity, preservedPath) {
  const nativeEntries = identity.entries.filter(
    (entry) =>
      entry.type === 'file' &&
      ['node-pty-native', 'parcel-watcher-native', 'native-runtime'].includes(entry.role)
  )
  return nativeEntries.map((entry) =>
    entry.path === preservedPath
      ? {
          path: entry.path,
          sourceSha256: entry.sha256,
          status: 'valid-upstream',
          signerSubject: 'CN=Microsoft Corporation',
          signerThumbprint: 'B'.repeat(40)
        }
      : { path: entry.path, sourceSha256: entry.sha256, status: 'unsigned' }
  )
}

async function createReturnedTree(stagingRoot, returnedRoot, selection) {
  await cp(stagingRoot, returnedRoot, { recursive: true, errorOnExist: true, force: false })
  for (const entry of selection.signingFiles) {
    await appendFile(join(returnedRoot, ...entry.path.split('/')), ':signed')
  }
}

describe('SSH relay runtime native signing payload', () => {
  it('authenticates Linux native bytes without creating a signing payload', async () => {
    const fixture = await runtimeFixture('linux-x64-glibc')
    try {
      const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
      const stagingRoot = join(fixture.root, 'stage')
      await expect(
        stageSshRelayRuntimeNativeSigningPayload({
          runtimeRoot: fixture.runtimeRoot,
          stagingRoot,
          selection
        })
      ).resolves.toEqual({
        tupleId: 'linux-x64-glibc',
        stagingRequired: false,
        stagedFiles: [],
        stagedSize: 0
      })
      await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('verifies all native bytes before exclusively staging only macOS signing files', async () => {
    const fixture = await runtimeFixture('darwin-arm64')
    try {
      const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
      const stagingRoot = join(fixture.root, 'stage')
      const report = await stageSshRelayRuntimeNativeSigningPayload({
        runtimeRoot: fixture.runtimeRoot,
        stagingRoot,
        selection
      })

      expect(report.stagedFiles.map((entry) => entry.path)).toEqual(
        selection.signingFiles.map((entry) => entry.path)
      )
      await expect(lstat(join(stagingRoot, 'bin', 'node'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      for (const entry of selection.signingFiles) {
        await expect(readFile(join(stagingRoot, ...entry.path.split('/')))).resolves.toEqual(
          await readFile(join(fixture.runtimeRoot, ...entry.path.split('/')))
        )
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('does not stage a Windows file whose valid upstream signature is preserved', async () => {
    const fixture = await runtimeFixture('win32-x64')
    try {
      const preservedPath = 'node_modules/node-pty/build/Release/conpty/OpenConsole.exe'
      const selection = buildSshRelayRuntimeNativeSigningSelection(
        fixture.identity,
        windowsAssessments(fixture.identity, preservedPath)
      )
      const stagingRoot = join(fixture.root, 'stage')
      const report = await stageSshRelayRuntimeNativeSigningPayload({
        runtimeRoot: fixture.runtimeRoot,
        stagingRoot,
        selection
      })

      expect(report.stagedFiles).toHaveLength(4)
      await expect(lstat(join(stagingRoot, ...preservedPath.split('/')))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects source mutation before creating a stage', async () => {
    const fixture = await runtimeFixture('darwin-x64')
    try {
      const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
      const stagingRoot = join(fixture.root, 'stage')
      await appendFile(join(fixture.runtimeRoot, 'bin', 'node'), ':mutated')
      await expect(
        stageSshRelayRuntimeNativeSigningPayload({
          runtimeRoot: fixture.runtimeRoot,
          stagingRoot,
          selection
        })
      ).rejects.toThrow(/authenticated size/i)
      await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an existing or source-nested staging root', async () => {
    const fixture = await runtimeFixture('darwin-arm64')
    try {
      const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
      const existing = join(fixture.root, 'existing')
      await mkdir(existing)
      await expect(
        stageSshRelayRuntimeNativeSigningPayload({
          runtimeRoot: fixture.runtimeRoot,
          stagingRoot: existing,
          selection
        })
      ).rejects.toThrow(/exclusive/i)
      await expect(
        stageSshRelayRuntimeNativeSigningPayload({
          runtimeRoot: fixture.runtimeRoot,
          stagingRoot: join(fixture.runtimeRoot, 'nested-stage'),
          selection
        })
      ).rejects.toThrow(/outside the runtime/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('removes a partial stage when authenticated signing-file copy fails', async () => {
    const fixture = await runtimeFixture('darwin-arm64')
    try {
      const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
      selection.signingFiles[1].sourceSha256 = `sha256:${'f'.repeat(64)}`
      const stagingRoot = join(fixture.root, 'stage')
      await expect(
        stageSshRelayRuntimeNativeSigningPayload({
          runtimeRoot: fixture.runtimeRoot,
          stagingRoot,
          selection
        })
      ).rejects.toThrow(/changed during copy/i)
      await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('accepts an exact returned tree only after every staged hash changes', async () => {
    const fixture = await runtimeFixture('darwin-arm64')
    try {
      const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
      const stagingRoot = join(fixture.root, 'stage')
      const returnedRoot = join(fixture.root, 'returned')
      await stageSshRelayRuntimeNativeSigningPayload({
        runtimeRoot: fixture.runtimeRoot,
        stagingRoot,
        selection
      })
      await createReturnedTree(stagingRoot, returnedRoot, selection)

      const report = await verifySshRelayRuntimeNativeSigningReturn({ returnedRoot, selection })
      expect(report.returnedFiles).toHaveLength(3)
      expect(report.returnedFiles.every((entry) => entry.signedSha256 !== entry.sourceSha256)).toBe(
        true
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects unchanged, missing, extra, and oversized returned bytes', async () => {
    const fixture = await runtimeFixture('darwin-x64')
    try {
      const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
      const stagingRoot = join(fixture.root, 'stage')
      await stageSshRelayRuntimeNativeSigningPayload({
        runtimeRoot: fixture.runtimeRoot,
        stagingRoot,
        selection
      })

      const unchangedRoot = join(fixture.root, 'unchanged')
      await cp(stagingRoot, unchangedRoot, { recursive: true })
      await expect(
        verifySshRelayRuntimeNativeSigningReturn({ returnedRoot: unchangedRoot, selection })
      ).rejects.toThrow(/did not change/i)

      const missingRoot = join(fixture.root, 'missing')
      await createReturnedTree(stagingRoot, missingRoot, selection)
      await rm(join(missingRoot, ...selection.signingFiles[0].path.split('/')))
      await expect(
        verifySshRelayRuntimeNativeSigningReturn({ returnedRoot: missingRoot, selection })
      ).rejects.toThrow(/missing returned file/i)

      const extraRoot = join(fixture.root, 'extra')
      await createReturnedTree(stagingRoot, extraRoot, selection)
      await writeFile(join(extraRoot, 'extra.node'), 'extra')
      await expect(
        verifySshRelayRuntimeNativeSigningReturn({ returnedRoot: extraRoot, selection })
      ).rejects.toThrow(/unexpected returned file/i)

      const oversizedRoot = join(fixture.root, 'oversized')
      await createReturnedTree(stagingRoot, oversizedRoot, selection)
      const first = selection.signingFiles[0]
      await truncate(
        join(oversizedRoot, ...first.path.split('/')),
        first.sourceSize + 4 * 1024 * 1024 + 1
      )
      await expect(
        verifySshRelayRuntimeNativeSigningReturn({ returnedRoot: oversizedRoot, selection })
      ).rejects.toThrow(/size bound/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink in returned signing bytes',
    async () => {
      const fixture = await runtimeFixture('darwin-arm64')
      try {
        const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
        const returnedRoot = join(fixture.root, 'returned')
        const target = join(fixture.root, 'target')
        const first = selection.signingFiles[0]
        await writeFile(target, 'signed')
        await mkdir(dirname(join(returnedRoot, ...first.path.split('/'))), { recursive: true })
        await symlink(target, join(returnedRoot, ...first.path.split('/')))
        await expect(
          verifySshRelayRuntimeNativeSigningReturn({ returnedRoot, selection })
        ).rejects.toThrow(/symbolic link/i)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')('rejects a symlinked native source file', async () => {
    const fixture = await runtimeFixture('darwin-x64')
    try {
      const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
      const first = selection.signingFiles[0]
      const sourcePath = join(fixture.runtimeRoot, ...first.path.split('/'))
      const target = join(fixture.root, 'native-target')
      await cp(sourcePath, target)
      await rm(sourcePath)
      await symlink(target, sourcePath)
      await expect(
        stageSshRelayRuntimeNativeSigningPayload({
          runtimeRoot: fixture.runtimeRoot,
          stagingRoot: join(fixture.root, 'stage'),
          selection
        })
      ).rejects.toThrow(/source is a symbolic link/i)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked staging parent that resolves inside the runtime',
    async () => {
      const fixture = await runtimeFixture('darwin-arm64')
      try {
        const selection = buildSshRelayRuntimeNativeSigningSelection(fixture.identity, [])
        const redirectedParent = join(fixture.root, 'redirected-parent')
        await symlink(fixture.runtimeRoot, redirectedParent)
        await expect(
          stageSshRelayRuntimeNativeSigningPayload({
            runtimeRoot: fixture.runtimeRoot,
            stagingRoot: join(redirectedParent, 'stage'),
            selection
          })
        ).rejects.toThrow(/outside the runtime/i)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
  )
})
