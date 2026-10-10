#!/usr/bin/env node
// Fetches the pinned GhosttyKit build (libghostty-spm, MIT) used by native/ghostty-terminal-macos.
// The release carries the host-managed IO and replay-without-replies patches that let Orca's
// daemon keep owning the PTY. Bump URL and SHA-256 together.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const LIBGHOSTTY_URL =
  'https://github.com/Lakr233/libghostty-spm/releases/download/upstream.35a81a980bb9/GhosttyKit.xcframework.zip'
const LIBGHOSTTY_SHA256 = '80e9bbfc89f5bd23ee028cff03024e3a788509f87812ab0bc9d697bf22a9472b'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const root = path.resolve(import.meta.dirname, '../..')
const vendorDir = path.join(root, 'native/ghostty-terminal-macos/vendor/libghostty')
const stampPath = path.join(vendorDir, '.sha256')
if (existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === LIBGHOSTTY_SHA256) {
  process.exit(0)
}

const response = await fetch(LIBGHOSTTY_URL)
if (!response.ok) {
  throw new Error(`libghostty download failed: HTTP ${response.status}`)
}
const archive = Buffer.from(await response.arrayBuffer())
const digest = createHash('sha256').update(archive).digest('hex')
if (digest !== LIBGHOSTTY_SHA256) {
  throw new Error(`libghostty checksum mismatch: expected ${LIBGHOSTTY_SHA256}, got ${digest}`)
}

const workDir = mkdtempSync(path.join(tmpdir(), 'orca-libghostty-'))
try {
  const zipPath = path.join(workDir, 'GhosttyKit.xcframework.zip')
  writeFileSync(zipPath, archive)
  execFileSync('ditto', ['-x', '-k', zipPath, workDir])
  const slice = path.join(workDir, 'GhosttyKit.xcframework/macos-arm64_x86_64')
  rmSync(vendorDir, { recursive: true, force: true })
  mkdirSync(path.join(vendorDir, 'lib'), { recursive: true })
  cpSync(path.join(slice, 'libghostty.a'), path.join(vendorDir, 'lib/libghostty.a'))
  cpSync(path.join(slice, 'Headers/libghostty'), path.join(vendorDir, 'include'), {
    recursive: true
  })
  writeFileSync(stampPath, `${LIBGHOSTTY_SHA256}\n`)
  console.log('libghostty: fetched pinned GhosttyKit build')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
