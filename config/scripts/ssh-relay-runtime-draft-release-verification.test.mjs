import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { verifySshRelayRuntimeDraftReleaseTransaction } from './ssh-relay-runtime-draft-release-verification.mjs'

const REPO = 'stablyai/orca'
const RELEASE_ID = 42
const TAG = 'v1.5.0-rc.1'
const SOURCE_COMMIT = 'a'.repeat(40)
const TOKEN = 'test-token'
const ARCHIVE_NAME = 'orca-ssh-relay-runtime-v1-linux-x64-glibc-a.tar.br'
const ARCHIVE_BYTES = Buffer.from('verified runtime archive')
const SECOND_ARCHIVE_NAME = 'orca-ssh-relay-runtime-v1-win32-x64-c.zip'
const SECOND_ARCHIVE_BYTES = Buffer.from('verified Windows runtime archive')
const MANIFEST_NAME = 'orca-ssh-relay-runtime-manifest.json'
const MANIFEST_BYTES = Buffer.from('signed immutable manifest')

let root
let readbackDirectory
let executionDirectory

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function identity(overrides = {}) {
  return {
    tupleId: 'linux-x64-glibc',
    contentId: `sha256:${'b'.repeat(64)}`,
    archive: {
      name: ARCHIVE_NAME,
      sha256: digest(ARCHIVE_BYTES),
      size: ARCHIVE_BYTES.length
    },
    ...overrides
  }
}

function assets() {
  return [
    {
      name: ARCHIVE_NAME,
      path: join(root, ARCHIVE_NAME),
      sha256: digest(ARCHIVE_BYTES),
      size: ARCHIVE_BYTES.length
    },
    {
      name: MANIFEST_NAME,
      path: join(root, MANIFEST_NAME),
      sha256: digest(MANIFEST_BYTES),
      size: MANIFEST_BYTES.length
    }
  ]
}

function assetIdentities() {
  return assets().map(({ path: _path, ...asset }) => asset)
}

function input(overrides = {}) {
  return {
    repo: REPO,
    releaseId: RELEASE_ID,
    tag: TAG,
    sourceCommit: SOURCE_COMMIT,
    token: TOKEN,
    assets: assets(),
    archiveIdentities: [identity()],
    readbackDirectory,
    executionDirectory,
    ...overrides
  }
}

function uploadResult(overrides = {}) {
  return {
    releaseId: RELEASE_ID,
    tag: TAG,
    sourceCommit: SOURCE_COMMIT,
    reusedAssets: [],
    uploadedAssets: assetIdentities(),
    ...overrides
  }
}

async function materializeResult(overrides = {}) {
  await mkdir(readbackDirectory, { recursive: true })
  return {
    releaseId: RELEASE_ID,
    tag: TAG,
    materializedAssets: assetIdentities().map((asset) => ({
      ...asset,
      path: join(readbackDirectory, asset.name)
    })),
    ...overrides
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-relay-draft-verification-')))
  readbackDirectory = join(root, 'readback')
  executionDirectory = join(root, 'execution')
  await Promise.all([
    writeFile(join(root, ARCHIVE_NAME), ARCHIVE_BYTES),
    writeFile(join(root, MANIFEST_NAME), MANIFEST_BYTES)
  ])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('SSH relay runtime draft release verification transaction', () => {
  it('runs only the contract suite in both native workflow families', async () => {
    const workflow = await readFile(
      join(import.meta.dirname, '../../.github/workflows/ssh-relay-runtime-artifacts.yml'),
      'utf8'
    )

    expect(workflow.match(/ssh-relay-runtime-draft-release-verification\.test\.mjs/g)).toHaveLength(
      4
    )
    expect(workflow.match(/ssh-relay-runtime-draft-release-verification\.mjs/g)).toHaveLength(2)
    expect(workflow).not.toMatch(
      /node config\/scripts\/ssh-relay-runtime-draft-release-verification\.mjs/
    )
  })

  it('orders upload, authenticated materialization, and exact archive execution', async () => {
    const order = []
    const uploadImpl = vi.fn(async () => {
      order.push('upload')
      return uploadResult()
    })
    const materializeImpl = vi.fn(async () => {
      order.push('materialize')
      return materializeResult()
    })
    const executeImpl = vi.fn(async ({ materializedArchive, outputDirectory }) => {
      order.push('execute')
      expect(materializedArchive).toEqual({
        ...assetIdentities()[0],
        path: join(readbackDirectory, ARCHIVE_NAME)
      })
      expect(outputDirectory).toBe(join(executionDirectory, identity().tupleId))
      await mkdir(outputDirectory)
      return {
        tupleId: identity().tupleId,
        contentId: identity().contentId,
        runtimeRoot: outputDirectory,
        smoke: { nodeVersion: 'v24.18.0' }
      }
    })

    await expect(
      verifySshRelayRuntimeDraftReleaseTransaction(
        input({ uploadImpl, materializeImpl, executeImpl })
      )
    ).resolves.toMatchObject({
      releaseId: RELEASE_ID,
      tag: TAG,
      sourceCommit: SOURCE_COMMIT,
      verifiedRuntimes: [
        {
          tupleId: identity().tupleId,
          contentId: identity().contentId,
          runtimeRoot: join(executionDirectory, identity().tupleId)
        }
      ]
    })
    expect(order).toEqual(['upload', 'materialize', 'execute'])
  })

  it('rejects archive/asset drift and unsafe output paths before upload', async () => {
    const uploadImpl = vi.fn()
    await expect(
      verifySshRelayRuntimeDraftReleaseTransaction(
        input({ archiveIdentities: [identity({ tupleId: '../escape' })], uploadImpl })
      )
    ).rejects.toThrow(/tuple|archive|identity/i)
    await expect(
      verifySshRelayRuntimeDraftReleaseTransaction(
        input({
          archiveIdentities: [identity({ archive: { ...identity().archive, size: 1 } })],
          uploadImpl
        })
      )
    ).rejects.toThrow(/archive|asset|identity/i)
    await mkdir(readbackDirectory)
    await expect(
      verifySshRelayRuntimeDraftReleaseTransaction(input({ uploadImpl }))
    ).rejects.toThrow(/exclusive|output|directory/i)
    expect(uploadImpl).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'retry exhaustion', 'partial upload'])(
    'does not materialize after %s',
    async (failure) => {
      const uploadImpl = vi.fn(async () => {
        throw new Error(failure)
      })
      const materializeImpl = vi.fn()

      await expect(
        verifySshRelayRuntimeDraftReleaseTransaction(
          input({ uploadImpl, materializeImpl, executeImpl: vi.fn() })
        )
      ).rejects.toThrow(failure)
      expect(materializeImpl).not.toHaveBeenCalled()
    }
  )

  it('does not remove an output path it never owned after upload failure', async () => {
    const marker = join(readbackDirectory, 'other-process.txt')
    const uploadImpl = vi.fn(async () => {
      await mkdir(readbackDirectory)
      await writeFile(marker, 'not owned by the transaction')
      throw new Error('upload failed before materialization')
    })

    await expect(
      verifySshRelayRuntimeDraftReleaseTransaction(
        input({ uploadImpl, materializeImpl: vi.fn(), executeImpl: vi.fn() })
      )
    ).rejects.toThrow(/upload failed/i)
    await expect(readdir(readbackDirectory)).resolves.toEqual(['other-process.txt'])
  })

  it('rejects upload/read-back identity drift before the next phase', async () => {
    const materializeImpl = vi.fn()
    await expect(
      verifySshRelayRuntimeDraftReleaseTransaction(
        input({
          uploadImpl: vi.fn(async () => uploadResult({ releaseId: RELEASE_ID + 1 })),
          materializeImpl,
          executeImpl: vi.fn()
        })
      )
    ).rejects.toThrow(/upload|release|identity|drift/i)
    expect(materializeImpl).not.toHaveBeenCalled()

    const executeImpl = vi.fn()
    await expect(
      verifySshRelayRuntimeDraftReleaseTransaction(
        input({
          uploadImpl: vi.fn(async () => uploadResult()),
          materializeImpl: vi.fn(async () => materializeResult({ materializedAssets: [] })),
          executeImpl
        })
      )
    ).rejects.toThrow(/read-back|materialized|asset|drift/i)
    expect(executeImpl).not.toHaveBeenCalled()
  })

  it('removes every owned output after materialization, execution, or cancellation failure', async () => {
    for (const failure of ['materialization', 'execution', 'cancellation']) {
      const controller = new AbortController()
      const materializeImpl = vi.fn(async () => {
        await mkdir(readbackDirectory)
        if (failure === 'materialization') {
          // The materializer owns and removes its partial transaction before rejecting.
          await rm(readbackDirectory, { recursive: true, force: true })
          throw new Error('partial materialization')
        }
        return materializeResult()
      })
      const executeImpl = vi.fn(async ({ outputDirectory }) => {
        await mkdir(outputDirectory)
        if (failure === 'cancellation') {
          controller.abort(new Error('cancel transaction'))
          controller.signal.throwIfAborted()
        }
        throw new Error('native execution failed')
      })

      await expect(
        verifySshRelayRuntimeDraftReleaseTransaction(
          input({
            uploadImpl: vi.fn(async () => uploadResult()),
            materializeImpl,
            executeImpl,
            signal: controller.signal
          })
        )
      ).rejects.toThrow(/materialization|execution|cancel|native/i)
      await expect(readdir(readbackDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readdir(executionDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('removes an earlier verified runtime when a later archive fails', async () => {
    const secondAsset = {
      name: SECOND_ARCHIVE_NAME,
      path: join(root, SECOND_ARCHIVE_NAME),
      sha256: digest(SECOND_ARCHIVE_BYTES),
      size: SECOND_ARCHIVE_BYTES.length
    }
    await writeFile(secondAsset.path, SECOND_ARCHIVE_BYTES)
    const allAssets = [...assets(), secondAsset]
    const returnedAssets = allAssets.map(({ path: _path, ...asset }) => asset)
    const secondIdentity = identity({
      tupleId: 'win32-x64',
      contentId: `sha256:${'c'.repeat(64)}`,
      archive: { ...returnedAssets.at(-1) }
    })
    const executeImpl = vi.fn(async ({ identity: candidate, outputDirectory }) => {
      await mkdir(outputDirectory)
      if (candidate.tupleId === secondIdentity.tupleId) {
        throw new Error('second archive native smoke failed')
      }
      return {
        tupleId: candidate.tupleId,
        contentId: candidate.contentId,
        runtimeRoot: outputDirectory,
        smoke: { nodeVersion: 'v24.18.0' }
      }
    })

    await expect(
      verifySshRelayRuntimeDraftReleaseTransaction(
        input({
          assets: allAssets,
          archiveIdentities: [identity(), secondIdentity],
          uploadImpl: vi.fn(async () => uploadResult({ uploadedAssets: returnedAssets })),
          materializeImpl: vi.fn(async () => {
            await mkdir(readbackDirectory)
            return {
              releaseId: RELEASE_ID,
              tag: TAG,
              materializedAssets: returnedAssets.map((asset) => ({
                ...asset,
                path: join(readbackDirectory, asset.name)
              }))
            }
          }),
          executeImpl
        })
      )
    ).rejects.toThrow(/second archive native smoke failed/i)
    expect(executeImpl).toHaveBeenCalledTimes(2)
    await expect(readdir(readbackDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(executionDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
