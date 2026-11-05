#!/usr/bin/env node
// Apple Intelligence text generation helper. Apple Silicon only: the model never exists on Intel,
// and the app hides the provider there, so there is nothing to run.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const nativeDir = path.join(repoRoot, 'native', 'on-device-model-macos')
const sourcePath = path.join(nativeDir, 'main.swift')
const args = process.argv.slice(2)
const outputPath =
  readArg('--output') ?? path.join(nativeDir, '.build', 'release', 'orca-on-device-model')

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.exit(0)
}

mkdirSync(path.dirname(outputPath), { recursive: true })
try {
  // FoundationModels needs the macOS 26 SDK; older toolchains cannot link it.
  execFileSync(
    'swiftc',
    ['-O', sourcePath, '-target', 'arm64-apple-macosx26.0', '-o', outputPath],
    {
      stdio: 'inherit'
    }
  )
} catch (error) {
  rmSync(outputPath, { force: true })
  console.warn(
    `[orca] on-device model helper not built (provider stays hidden): ${error?.message ?? error}`
  )
  process.exit(0)
}
chmodSync(outputPath, 0o755)

function readArg(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
