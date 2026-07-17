import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { materializeSshRelayRuntimeDraftReadback } from './ssh-relay-runtime-draft-readback.mjs'

const REPO = 'stablyai/orca'
const RELEASE_ID = 42
const TAG = 'v1.4.140-rc.1'
const TOKEN = 'secret-token'
const NAME = 'orca-ssh-relay-runtime-v1-linux-x64-glibc-a.tar.br'
const BYTES = Buffer.from('immutable release bytes')
const SECOND_NAME = 'orca-ssh-relay-runtime-manifest.json'
const SECOND_BYTES = Buffer.from('immutable manifest bytes')

let root

function expectedAsset(name = NAME, bytes = BYTES) {
  return {
    name,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length
  }
}

function release(expectedAssets) {
  return {
    id: RELEASE_ID,
    tag_name: TAG,
    draft: true,
    assets: expectedAssets.map((asset, index) => ({
      id: 101 + index,
      name: asset.name,
      state: 'uploaded',
      size: asset.size
    }))
  }
}

function fetchFixture(expectedAssets, assetResponses) {
  const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(release(expectedAssets)))
  for (const response of assetResponses) {
    fetchImpl.mockResolvedValueOnce(response)
  }
  return fetchImpl
}

function input(expectedAssets, fetchImpl, overrides = {}) {
  return {
    repo: REPO,
    releaseId: RELEASE_ID,
    tag: TAG,
    token: TOKEN,
    expectedAssets,
    outputDirectory: join(root, 'readback'),
    fetchImpl,
    ...overrides
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-relay-draft-readback-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('SSH relay runtime draft read-back materialization', () => {
  it('streams each asset once and exposes its final name only after exact verification', async () => {
    const expected = expectedAsset()
    let finish
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(BYTES.subarray(0, 5))
        finish = () => {
          controller.enqueue(BYTES.subarray(5))
          controller.close()
        }
      }
    })
    const fetchImpl = fetchFixture([expected], [new Response(body)])
    const outputDirectory = join(root, 'readback')
    const physicalOutput = join(await realpath(root), 'readback')
    const materialization = materializeSshRelayRuntimeDraftReadback(
      input([expected], fetchImpl, { outputDirectory })
    )

    await vi.waitFor(async () => expect((await readdir(outputDirectory)).length).toBe(1))
    const namesDuringDownload = await readdir(outputDirectory)
    expect(namesDuringDownload).not.toContain(NAME)
    finish()

    await expect(materialization).resolves.toEqual({
      releaseId: RELEASE_ID,
      tag: TAG,
      materializedAssets: [{ ...expected, path: join(physicalOutput, NAME) }]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(await readdir(outputDirectory)).toEqual([NAME])
    expect(await readFile(join(outputDirectory, NAME))).toEqual(BYTES)
  })

  it('requires an absent output directory below an existing real parent before requesting GitHub', async () => {
    const expected = expectedAsset()
    const existingOutput = join(root, 'existing')
    await mkdir(existingOutput)

    for (const outputDirectory of [existingOutput, join(root, 'missing-parent', 'readback')]) {
      const fetchImpl = vi.fn()
      await expect(
        materializeSshRelayRuntimeDraftReadback(input([expected], fetchImpl, { outputDirectory }))
      ).rejects.toThrow(/absent|parent|no such file/i)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('removes the entire output when a later asset fails verification', async () => {
    const expectedAssets = [expectedAsset(), expectedAsset(SECOND_NAME, SECOND_BYTES)]
    const fetchImpl = fetchFixture(expectedAssets, [
      new Response(BYTES),
      new Response(Buffer.from('changed manifest bytes'))
    ])
    const outputDirectory = join(root, 'readback')

    await expect(
      materializeSshRelayRuntimeDraftReadback(input(expectedAssets, fetchImpl, { outputDirectory }))
    ).rejects.toThrow(/size|sha-?256/i)
    await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes partial bytes when cancellation interrupts a streamed asset', async () => {
    const expected = expectedAsset()
    const controller = new AbortController()
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(BYTES.subarray(0, 5))
      }
    })
    const outputDirectory = join(root, 'readback')
    const materialization = materializeSshRelayRuntimeDraftReadback(
      input([expected], fetchFixture([expected], [new Response(body)]), {
        outputDirectory,
        signal: controller.signal
      })
    )

    await vi.waitFor(async () => expect((await readdir(outputDirectory)).length).toBe(1))
    controller.abort(new Error('cancel materialization'))

    await expect(materialization).rejects.toThrow(/cancel materialization/i)
    await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
