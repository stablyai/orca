import {
  chmodSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COMPUTER_SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000
const COMPUTER_SCREENSHOT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const COMPUTER_SCREENSHOT_CLEANUP_MARKER = '.last-cleanup'

export function writeComputerScreenshotTempFile(
  responseId: string,
  base64Data: string,
  extension: 'png' | 'img'
): { outputPath: string; expiresAt: string } {
  const outputDir = computerScreenshotTempDir()
  cleanupComputerScreenshots(outputDir)
  const outputPath = join(outputDir, `${safeCliFileStem(responseId)}-screenshot.${extension}`)
  writeFileSync(outputPath, Buffer.from(base64Data, 'base64'), { mode: 0o600 })
  return {
    outputPath,
    expiresAt: new Date(Date.now() + COMPUTER_SCREENSHOT_TTL_MS).toISOString()
  }
}

function computerScreenshotTempDir(): string {
  const outputDir =
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR || join(tmpdir(), 'orca-computer-use')
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(outputDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe computer screenshot temp path: ${outputDir}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Computer screenshot temp path is not owned by the current user: ${outputDir}`)
  }
  chmodSync(outputDir, 0o700)
  return outputDir
}

function cleanupComputerScreenshots(outputDir: string): void {
  const now = Date.now()
  const markerPath = join(outputDir, COMPUTER_SCREENSHOT_CLEANUP_MARKER)
  try {
    // Why: agents can call computer-use CLI commands in loops; a marker keeps
    // temp cleanup from becoming a synchronous directory scan per screenshot.
    if (statSync(markerPath).mtimeMs > now - COMPUTER_SCREENSHOT_CLEANUP_INTERVAL_MS) {
      return
    }
  } catch {
    // Missing or unreadable marker means this process should attempt cleanup.
  }

  const cutoff = now - COMPUTER_SCREENSHOT_TTL_MS
  const directory = opendirSync(outputDir)
  try {
    while (true) {
      const entry = directory.readSync()
      if (!entry) {
        break
      }
      if (!entry.name.endsWith('-screenshot.png') && !entry.name.endsWith('-screenshot.img')) {
        continue
      }
      const path = join(outputDir, entry.name)
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { force: true })
        }
      } catch {
        // Best-effort cleanup only; formatting should not fail because a temp file raced.
      }
    }
  } finally {
    try {
      directory.closeSync()
    } catch {
      // Best-effort cleanup only.
    }
  }
  try {
    writeFileSync(markerPath, `${now}\n`, { mode: 0o600 })
  } catch {
    // Best-effort marker only; stale cleanup state should not hide a screenshot.
  }
}

function safeCliFileStem(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}
