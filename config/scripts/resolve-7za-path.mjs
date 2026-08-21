#!/usr/bin/env node

// Why: electron-builder 26.9+ dropped the bundled `7zip-bin` package in favour of a
// toolset downloaded at build time, so the hardcoded `node_modules/7zip-bin/...` path
// the release signing gates used silently stopped resolving (#6487).

import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

// Why not existsSync: PowerShell's `Test-Path` is true for directories too, so a
// override pointing at a folder would satisfy both checks and only fail later as
// an opaque exec error inside the gate.
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Legacy layout, still valid if a transitive dep reintroduces 7zip-bin. The
// package ships `mac/`, not `darwin/`, and keeps a separate ia32 build.
export function legacy7zaRelativePath(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return ['node_modules', '7zip-bin', 'win', arch, '7za.exe']
  }
  const dir = platform === 'darwin' ? 'mac' : platform
  return ['node_modules', '7zip-bin', dir, arch, '7za']
}

// app-builder-lib logs download progress to stdout, which would corrupt the
// single-path contract the PowerShell gates parse. Divert it to stderr so a
// cold toolset cache stays debuggable without breaking the caller.
//
// Why refcounted: patching `process.stdout.write` is process-global, so two
// concurrent callers would each capture the other's patched function as their
// "original" and the last `finally` would restore a diverting stub permanently.
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

  // app-builder-lib reads the same env var and hard-fails on a stale value, so a
  // dangling override must be cleared rather than passed through to the download.
  const restoreOverride = override !== undefined
  if (restoreOverride) {
    delete process.env.ELECTRON_BUILDER_7ZIP_PATH
  }
  try {
    // The toolset is cached after the first download, so a release build has
    // already paid this cost by the time the signing gate runs.
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
