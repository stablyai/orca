import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import {
  binaryNameForPlatform,
  distDirectoryName,
  rustTargetTriple,
  stageBuiltBinary,
  verifyPrebuiltSidecar,
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

test('verifies and restores executable mode on a downloaded prebuilt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-micro-prebuilt-'))
  const output = join(root, 'linux-x64', 'codex-micro')
  await stageBuiltBinary({
    source: process.execPath,
    distRoot: root,
    platform: 'linux',
    arch: 'x64'
  })
  await chmod(output, 0o644)
  const calls = []

  assert.equal(
    await verifyPrebuiltSidecar({
      platform: 'linux',
      arch: 'x64',
      distRoot: root,
      verifyLinux: (path) => calls.push(path)
    }),
    output
  )
  assert.equal((await stat(output)).mode & 0o111, 0o111)
  assert.deepEqual(calls, [join(root, 'linux-x64')])
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

test('CI builds Ubuntu 20.04 sidecars before Linux release packaging', async () => {
  const workflowRoot = join(import.meta.dirname, '..', '..', '.github', 'workflows')
  const release = parseYaml(await readFile(join(workflowRoot, 'release-cut.yml'), 'utf8'))
  const pr = parseYaml(await readFile(join(workflowRoot, 'pr.yml'), 'utf8'))
  const sidecarJob = release.jobs['build-codex-micro-linux']
  const releaseJob = release.jobs.build
  const prFloorJob = pr.jobs['codex-micro-linux-floor']
  const pinnedRustAction = 'dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4'

  assert.equal(sidecarJob.container, 'ubuntu:20.04')
  assert.deepEqual(
    sidecarJob.strategy.matrix.include.map(({ arch }) => arch),
    ['x64', 'arm64']
  )
  assert.ok(releaseJob.needs.includes('build-codex-micro-linux'))
  assert.ok(releaseJob.steps.some(({ name }) => name === 'Download Codex Micro sidecar'))
  assert.equal(
    releaseJob.steps.find(({ name }) => name === 'Build app').env.ORCA_CODEX_MICRO_PREBUILT,
    "${{ startsWith(matrix.platform, 'linux-') && '1' || '' }}"
  )
  assert.equal(prFloorJob.container, 'ubuntu:20.04')
  for (const job of [sidecarJob, prFloorJob]) {
    assert.match(job.steps.find(({ name }) => name === 'Install build tools').run, /\bbinutils\b/)
    const rust = job.steps.find(({ name }) => name === 'Setup Rust')
    assert.equal(rust.uses, pinnedRustAction)
    assert.equal(rust.with.toolchain, '1.97.1')
  }
})
