#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { access, chmod, copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { verifyLinuxGlibcFloor } = require('./verify-linux-glibc-floor.cjs')

const repoRoot = resolve(import.meta.dirname, '../..')
const manifestPath = join(repoRoot, 'native', 'codex-micro', 'Cargo.toml')
const targetRoot = join(repoRoot, 'native', 'codex-micro', 'target')
const distRoot = join(repoRoot, 'native', 'codex-micro', 'dist')

export function rustTargetTriple(platform, arch) {
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc'
  }
  const triple = triples[`${platform}-${arch}`]
  if (!triple) {
    throw new Error(`Unsupported Codex Micro target: ${platform}-${arch}`)
  }
  return triple
}

export function binaryNameForPlatform(platform) {
  return platform === 'win32' ? 'codex-micro.exe' : 'codex-micro'
}

export function distDirectoryName(platform, arch) {
  return `${platform}-${arch}`
}

export async function stageBuiltBinary({ source, distRoot, platform, arch }) {
  const outputDir = join(distRoot, distDirectoryName(platform, arch))
  const output = join(outputDir, binaryNameForPlatform(platform))
  await mkdir(outputDir, { recursive: true })
  await copyFile(source, output)
  if (platform !== 'win32') {
    await chmod(output, 0o755)
  }
  return output
}

export function verifyStagedSidecar({ platform, output, verifyLinux = verifyLinuxGlibcFloor }) {
  if (platform === 'linux') {
    verifyLinux(dirname(output))
  }
}

export async function verifyPrebuiltSidecar({
  platform = process.platform,
  arch = process.env.npm_config_arch || process.arch,
  distRoot: prebuiltDistRoot = distRoot,
  verifyLinux = verifyLinuxGlibcFloor
} = {}) {
  const output = join(
    prebuiltDistRoot,
    distDirectoryName(platform, arch),
    binaryNameForPlatform(platform)
  )
  try {
    await access(output)
  } catch {
    throw new Error(`Missing prebuilt Codex Micro sidecar: ${output}`)
  }
  if (platform !== 'win32') {
    await chmod(output, 0o755)
  }
  verifyStagedSidecar({ platform, output, verifyLinux })
  console.log(`[codex-micro-build] verified prebuilt ${output}`)
  return output
}

export async function buildCodexMicroSidecar({
  platform = process.platform,
  arch = process.env.npm_config_arch || process.arch
} = {}) {
  const triple = rustTargetTriple(platform, arch)
  const result = spawnSync(
    'cargo',
    ['build', '--manifest-path', manifestPath, '--release', '--target', triple],
    { cwd: repoRoot, stdio: 'inherit' }
  )
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.error || result.status !== 0) {
    throw new Error(`Codex Micro Cargo build failed for ${triple}`)
  }
  const source = join(targetRoot, triple, 'release', binaryNameForPlatform(platform))
  const output = await stageBuiltBinary({ source, distRoot, platform, arch })
  verifyStagedSidecar({ platform, output })
  console.log(`[codex-micro-build] staged ${output}`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await (process.argv.includes('--verify-prebuilt')
    ? verifyPrebuiltSidecar()
    : buildCodexMicroSidecar())
}
