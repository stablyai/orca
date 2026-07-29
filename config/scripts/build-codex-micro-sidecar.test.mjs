import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  binaryNameForPlatform,
  distDirectoryName,
  rustTargetTriple,
  stageBuiltBinary,
  verifyStagedSidecar
} from './build-codex-micro-sidecar.mjs'

const require = createRequire(import.meta.url)
const { collectNativeBinaries } = require('./verify-linux-glibc-floor.cjs')

test('selects target triples and Windows suffixes', () => {
  assert.equal(rustTargetTriple('darwin', 'arm64'), 'aarch64-apple-darwin')
  assert.equal(rustTargetTriple('darwin', 'x64'), 'x86_64-apple-darwin')
  assert.equal(rustTargetTriple('linux', 'x64'), 'x86_64-unknown-linux-gnu')
  assert.equal(rustTargetTriple('win32', 'x64'), 'x86_64-pc-windows-msvc')
  assert.equal(binaryNameForPlatform('win32'), 'codex-micro.exe')
  assert.equal(binaryNameForPlatform('linux'), 'codex-micro')
  assert.equal(distDirectoryName('linux', 'arm64'), 'linux-arm64')
})

test('stages deterministic executable resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-micro-build-'))
  const source = join(root, 'source')
  const distRoot = join(root, 'dist')
  await writeFile(source, 'binary')

  const output = await stageBuiltBinary({ source, distRoot, platform: 'linux', arch: 'x64' })

  assert.equal(output, join(distRoot, 'linux-x64', 'codex-micro'))
  assert.equal(await readFile(output, 'utf8'), 'binary')
  assert.equal((await stat(output)).mode & 0o111, 0o111)
})

test('runs the glibc floor gate only for Linux staged output', () => {
  const calls = []
  const verifyLinux = (root) => calls.push(root)
  verifyStagedSidecar({
    platform: 'linux',
    output: '/tmp/dist/linux-x64/codex-micro',
    verifyLinux
  })
  verifyStagedSidecar({
    platform: 'darwin',
    output: '/tmp/dist/darwin-x64/codex-micro',
    verifyLinux
  })
  assert.deepEqual(calls, ['/tmp/dist/linux-x64'])
})

test('packaging maps every platform and Linux scanning finds the sidecar', async () => {
  const config = require('../electron-builder.config.cjs')
  assert.ok(
    config.win.extraResources.some((resource) => resource.to === 'codex-micro/codex-micro.exe')
  )
  assert.ok(config.mac.extraResources.some((resource) => resource.to === 'codex-micro/codex-micro'))
  assert.ok(
    config.linux.extraResources.some((resource) => resource.to === 'codex-micro/codex-micro')
  )

  const root = await mkdtemp(join(tmpdir(), 'codex-micro-glibc-'))
  const binary = join(root, 'codex-micro')
  await writeFile(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  assert.deepEqual(collectNativeBinaries(root), [binary])
})
