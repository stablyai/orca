#!/usr/bin/env node
// Downloads Microsoft's standalone vscode-js-debug DAP server bundle (the
// `js-debug-dap-vX.Y.Z.tar.gz` GitHub release asset — a build meant for
// non-VS-Code DAP clients, distinct from the `.vsix` extension package) and
// unpacks it under resources/debug-adapters/js-debug/. Not published to npm,
// so this is the only install path. Idempotent: skips re-downloading when
// the pinned version is already unpacked with a matching entrypoint.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as tar from 'tar'

const ROOT = path.join(import.meta.dirname, '..', '..')
const DEST_ROOT = path.join(ROOT, 'resources', 'debug-adapters', 'js-debug')
const VERSION_MARKER_FILENAME = '.orca-vendored-version'

// Bump together: VERSION must match a real microsoft/vscode-js-debug release
// tag, and SHA256 must be the published `js-debug-dap-v<VERSION>.tar.gz`
// asset's checksum (`shasum -a 256 js-debug-dap-v<VERSION>.tar.gz`).
const VERSION = '1.117.0'
const SHA256 = 'ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772'
const DOWNLOAD_URL = `https://github.com/microsoft/vscode-js-debug/releases/download/v${VERSION}/js-debug-dap-v${VERSION}.tar.gz`

async function alreadyVendored() {
  const markerPath = path.join(DEST_ROOT, VERSION_MARKER_FILENAME)
  const entrypointPath = path.join(DEST_ROOT, 'src', 'dapDebugServer.js')
  if (!existsSync(markerPath) || !existsSync(entrypointPath)) {
    return false
  }
  return (await readFile(markerPath, 'utf8')).trim() === VERSION
}

class ChecksumMismatchError extends Error {}

async function downloadTarball(destPath) {
  const response = await fetch(DOWNLOAD_URL)
  if (!response.ok) {
    throw new Error(`GET ${DOWNLOAD_URL} failed: ${response.status} ${response.statusText}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== SHA256) {
    throw new ChecksumMismatchError(
      `js-debug-dap-v${VERSION}.tar.gz checksum mismatch: expected ${SHA256}, got ${hash}`
    )
  }
  await writeFile(destPath, bytes)
}

async function main() {
  if (await alreadyVendored()) {
    console.log(`[vendor:js-debug] v${VERSION} already present at ${DEST_ROOT}`)
    return
  }

  const stagingDir = await mkdtemp(path.join(tmpdir(), 'orca-js-debug-vendor-'))
  try {
    const tarballPath = path.join(stagingDir, 'js-debug-dap.tar.gz')
    console.log(`[vendor:js-debug] downloading v${VERSION}...`)
    await downloadTarball(tarballPath)

    await rm(DEST_ROOT, { recursive: true, force: true })
    await mkdir(DEST_ROOT, { recursive: true })
    // strip: 1 drops the tarball's top-level `js-debug/` directory so
    // dapDebugServer.js lands at DEST_ROOT/src/dapDebugServer.js.
    await tar.x({ file: tarballPath, cwd: DEST_ROOT, strip: 1 })

    await writeFile(path.join(DEST_ROOT, VERSION_MARKER_FILENAME), `${VERSION}\n`)
    console.log(`[vendor:js-debug] unpacked v${VERSION} to ${DEST_ROOT}`)
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  if (error instanceof ChecksumMismatchError) {
    // Fatal: corrupted or tampered download, never ship it silently.
    console.error(`[vendor:js-debug] ${error.message}`)
    process.exit(1)
  }
  // Why non-fatal otherwise: this runs as part of `dev`/`build:desktop`, and
  // a developer without network access (or GitHub being briefly unreachable)
  // should not lose the entire app — only the debugger feature degrades.
  console.warn(
    `[vendor:js-debug] could not vendor vscode-js-debug (Node/Chrome debugging will be unavailable): ${error instanceof Error ? error.message : String(error)}`
  )
}
