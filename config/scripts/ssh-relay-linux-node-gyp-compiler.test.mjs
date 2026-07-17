import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { applySshRelayLinuxNodeGypCompilerFloor } from './ssh-relay-linux-node-gyp-compiler.mjs'

const fixtureDirectories = []

async function fixture(source) {
  const nodeRoot = await mkdtemp(join(tmpdir(), 'orca-relay-node-gyp-'))
  fixtureDirectories.push(nodeRoot)
  const includeDirectory = join(nodeRoot, 'include', 'node')
  await mkdir(includeDirectory, { recursive: true })
  await writeFile(join(includeDirectory, 'common.gypi'), source)
  return nodeRoot
}

afterEach(async () => {
  await Promise.all(fixtureDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('SSH relay Linux node-gyp compiler floor', () => {
  it('uses the GCC 8 spelling for exactly one official Node C++20 flag', async () => {
    const nodeRoot = await fixture("'cflags_cc': [ '-std=gnu++20', ],\n")

    await expect(
      applySshRelayLinuxNodeGypCompilerFloor({ nodeRoot, tuple: 'linux-x64-glibc' })
    ).resolves.toMatchObject({ changed: true, standard: 'gnu++2a' })
    await expect(readFile(join(nodeRoot, 'include', 'node', 'common.gypi'), 'utf8')).resolves.toBe(
      "'cflags_cc': [ '-std=gnu++2a', ],\n"
    )
  })

  it('does not alter non-Linux Node build inputs', async () => {
    const nodeRoot = await fixture("'cflags_cc': [ '-std=gnu++20', ],\n")

    await expect(
      applySshRelayLinuxNodeGypCompilerFloor({ nodeRoot, tuple: 'darwin-x64' })
    ).resolves.toEqual({ changed: false })
    await expect(readFile(join(nodeRoot, 'include', 'node', 'common.gypi'), 'utf8')).resolves.toBe(
      "'cflags_cc': [ '-std=gnu++20', ],\n"
    )
  })

  it.each([
    ['', 0],
    ["'-std=gnu++20', '-std=gnu++20',", 2]
  ])('fails closed when the official flag count is not one', async (source, count) => {
    const nodeRoot = await fixture(source)

    await expect(
      applySshRelayLinuxNodeGypCompilerFloor({ nodeRoot, tuple: 'linux-arm64-glibc' })
    ).rejects.toThrow(`Expected exactly one Node Linux C++20 compiler flag, found ${count}`)
  })
})
