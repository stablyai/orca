#!/usr/bin/env node
// Cross-compiles the userspace tailnet sidecar (native/ts-sidecar) into a
// per-platform/arch binary whose name matches tsSidecarBinaryName() so
// electron-builder can copy it into resources/ts-sidecar.
//
// Usage:
//   node config/scripts/build-ts-sidecar.mjs                 # host platform/arch
//   node config/scripts/build-ts-sidecar.mjs --platform win32 --arch x64
//
// Node platform/arch names are used for the output filename; they are mapped to
// Go's GOOS/GOARCH for the build.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const moduleDir = join(repoRoot, 'native', 'ts-sidecar')

const GOOS_BY_PLATFORM = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const GOARCH_BY_ARCH = { x64: 'amd64', arm64: 'arm64' }

// Arches electron-builder may package per platform; the binary name embeds the
// arch via ${arch}, so every packaged arch needs a matching binary.
const ARCHES_BY_PLATFORM = { darwin: ['arm64', 'x64'], linux: ['x64', 'arm64'], win32: ['x64'] }

export function archesForPlatform(platform) {
  return ARCHES_BY_PLATFORM[platform] ?? [process.arch]
}

function parseArgs(argv) {
  const args = { platform: process.platform, arch: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform') {
      args.platform = argv[(i += 1)]
    } else if (argv[i] === '--arch') {
      args.arch = argv[(i += 1)]
    }
  }
  return args
}

export function sidecarBinaryName(platform, arch) {
  const ext = platform === 'win32' ? '.exe' : ''
  return `ts-sidecar-${platform}-${arch}${ext}`
}

export function goEnvFor(platform, arch) {
  const goos = GOOS_BY_PLATFORM[platform]
  const goarch = GOARCH_BY_ARCH[arch]
  if (!goos) {
    throw new Error(`Unsupported platform for ts-sidecar: ${platform}`)
  }
  if (!goarch) {
    throw new Error(`Unsupported arch for ts-sidecar: ${arch}`)
  }
  return { GOOS: goos, GOARCH: goarch }
}

export function buildSidecar({ platform, arch }) {
  if (!existsSync(join(moduleDir, 'go.mod'))) {
    throw new Error(`ts-sidecar module not found at ${moduleDir}`)
  }
  const outputName = sidecarBinaryName(platform, arch)
  const env = { ...process.env, ...goEnvFor(platform, arch), CGO_ENABLED: '0' }
  execFileSync('go', ['build', '-trimpath', '-o', outputName, '.'], {
    cwd: moduleDir,
    env,
    stdio: 'inherit'
  })
  return join(moduleDir, outputName)
}

// Only run when invoked directly, so the pure helpers can be unit-tested.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { platform, arch } = parseArgs(process.argv.slice(2))
  const arches = arch ? [arch] : archesForPlatform(platform)
  for (const target of arches) {
    const output = buildSidecar({ platform, arch: target })
    console.log(`Built ts-sidecar: ${output}`)
  }
}
