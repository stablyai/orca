#!/usr/bin/env node

// Resolve electron-builder toolset: 26.9+ dropped bundled 7zip-bin, breaking hardcoded signing-gate path (#6487).

import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

// Require file, not merely existence: PowerShell Test-Path accepts directories that fail later as opaque exec errors.
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Retain legacy 7zip-bin if transitive dependency returns; its layout uses mac/, not darwin/, and separate ia32.
export function legacy7zaRelativePath(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return ['node_modules', '7zip-bin', 'win', arch, '7za.exe']
  }
  const dir = platform === 'darwin' ? 'mac' : platform
  return ['node_modules', '7zip-bin', dir, arch, '7za']
}

// Divert toolset download logs to stderr to preserve PowerShell’s one-path stdout contract.
// Refcount global stdout patch: overlapping save/restores can otherwise leave a diverting stub installed permanently.
let stdoutDivertDepth = 0
let originalStdoutWrite = null

async function withStdoutDivertedToStderr(run) {
  if (stdoutDivertDepth === 0) {
    originalStdoutWrite = process.stdout.write
    process.stdout.write = (chunk, encoding, callback) =>
      process.stderr.write(chunk, encoding, callback)
  }
  stdoutDivertDepth += 1
  try {
    return await run()
  } finally {
    stdoutDivertDepth -= 1
    if (stdoutDivertDepth === 0) {
      process.stdout.write = originalStdoutWrite
      originalStdoutWrite = null
    }
  }
}

export async function resolve7zaPath(projectDir = process.cwd()) {
  const override = process.env.ELECTRON_BUILDER_7ZIP_PATH
  if (override && isFile(override)) {
    return override
  }

  const legacy = resolve(projectDir, ...legacy7zaRelativePath())
  if (isFile(legacy)) {
    return legacy
  }

  // Clear stale override: app-builder-lib reads same variable and fails rather than downloading when it dangles.
  const restoreOverride = override !== undefined
  if (restoreOverride) {
    delete process.env.ELECTRON_BUILDER_7ZIP_PATH
  }
  try {
    // Release build normally warmed the toolset cache before signing gate runs.
    const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
    const toolsetPath = await withStdoutDivertedToStderr(() => getPath7za())
    if (!existsSync(toolsetPath)) {
      throw new Error(`app-builder-lib returned a 7za path that does not exist: ${toolsetPath}`)
    }
    return toolsetPath
  } finally {
    if (restoreOverride) {
      process.env.ELECTRON_BUILDER_7ZIP_PATH = override
    }
  }
}

if (import.meta.filename === process.argv[1]) {
  try {
    process.stdout.write(`${await resolve7zaPath()}\n`)
  } catch (error) {
    process.stderr.write(`Could not resolve a 7za executable: ${error.message}\n`)
    process.exit(1)
  }
}
