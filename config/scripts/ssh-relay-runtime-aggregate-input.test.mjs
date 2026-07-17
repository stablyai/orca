import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  verifySshRelayRuntimeAggregateFiles,
  verifySshRelayRuntimeAggregateInputs
} from './ssh-relay-runtime-aggregate-input.mjs'

const temporaryDirectories = []

async function fixture() {
  const inputDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-aggregate-'))
  temporaryDirectories.push(inputDirectory)
  const contentId = `sha256:${'a'.repeat(64)}`
  const bytes = Buffer.from('verified runtime bytes')
  const name = `orca-ssh-relay-runtime-v1-linux-x64-glibc-${contentId.slice(7)}.tar.br`
  await writeFile(join(inputDirectory, name), bytes)
  return {
    inputDirectory,
    assets: [
      {
        tupleId: 'linux-x64-glibc',
        name,
        contentId,
        sha256: 'sha256:d4c28c942ea1505c048b33251b3afb8b7f1ce9c54d629c9e4c8923afd93d9f45',
        size: bytes.length
      }
    ]
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay runtime aggregate inputs', () => {
  it('accepts only exact immutable runtime archive bytes', async () => {
    const input = await fixture()

    await expect(verifySshRelayRuntimeAggregateInputs(input)).resolves.toEqual(input.assets)
  })

  it('rejects a hash or size mismatch', async () => {
    const hash = await fixture()
    hash.assets[0].sha256 = `sha256:${'f'.repeat(64)}`
    await expect(verifySshRelayRuntimeAggregateInputs(hash)).rejects.toThrow(/sha-?256/i)

    const size = await fixture()
    size.assets[0].size += 1
    await expect(verifySshRelayRuntimeAggregateInputs(size)).rejects.toThrow(/size/i)
  })

  it('rejects missing or extra inputs', async () => {
    const missing = await fixture()
    await rm(join(missing.inputDirectory, missing.assets[0].name))
    await expect(verifySshRelayRuntimeAggregateInputs(missing)).rejects.toThrow(/missing|exact/i)

    const extra = await fixture()
    await writeFile(join(extra.inputDirectory, 'unexpected.bin'), 'extra')
    await expect(verifySshRelayRuntimeAggregateInputs(extra)).rejects.toThrow(/unexpected|exact/i)
  })

  it.skipIf(process.platform === 'win32')('rejects a linked archive input', async () => {
    const input = await fixture()
    const path = join(input.inputDirectory, input.assets[0].name)
    const target = join(input.inputDirectory, 'target')
    await writeFile(target, 'target')
    await rm(path)
    await symlink(target, path)

    await expect(verifySshRelayRuntimeAggregateInputs(input)).rejects.toThrow(/unexpected|regular/i)
  })

  it('rejects duplicate tuples, names, and unsupported identities', async () => {
    const duplicateTuple = await fixture()
    duplicateTuple.assets.push({ ...duplicateTuple.assets[0], name: 'different.tar.br' })
    await expect(verifySshRelayRuntimeAggregateInputs(duplicateTuple)).rejects.toThrow(
      /duplicate tuple/i
    )

    const duplicateName = await fixture()
    duplicateName.assets.push({ ...duplicateName.assets[0], tupleId: 'linux-arm64-glibc' })
    await expect(verifySshRelayRuntimeAggregateInputs(duplicateName)).rejects.toThrow(
      /duplicate asset/i
    )

    const unsupported = await fixture()
    unsupported.assets[0].tupleId = 'linux-riscv64-glibc'
    await expect(verifySshRelayRuntimeAggregateInputs(unsupported)).rejects.toThrow(
      /unsupported tuple/i
    )
  })

  it('derives the archive name from tuple and content identity', async () => {
    const input = await fixture()
    input.assets[0].name = 'latest.tar.br'

    await expect(verifySshRelayRuntimeAggregateInputs(input)).rejects.toThrow(/archive name/i)
  })

  it('honors cancellation before reading an archive', async () => {
    const input = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancel aggregate'))

    await expect(
      verifySshRelayRuntimeAggregateInputs({ ...input, signal: controller.signal })
    ).rejects.toThrow(/cancel aggregate/i)
  })

  it('bounds the generalized aggregate file count and declared total size', async () => {
    const input = await fixture()
    const reference = {
      name: 'file-0.bin',
      size: 100 * 1024 * 1024,
      sha256: `sha256:${'a'.repeat(64)}`
    }
    const tooMany = Array.from({ length: 33 }, (_, index) => ({
      ...reference,
      name: `file-${index}.bin`,
      size: 1
    }))
    await expect(
      verifySshRelayRuntimeAggregateFiles({ inputDirectory: input.inputDirectory, files: tooMany })
    ).rejects.toThrow(/bounded/i)

    const tooLarge = Array.from({ length: 11 }, (_, index) => ({
      ...reference,
      name: `file-${index}.bin`
    }))
    await expect(
      verifySshRelayRuntimeAggregateFiles({ inputDirectory: input.inputDirectory, files: tooLarge })
    ).rejects.toThrow(/total size/i)
  })
})
