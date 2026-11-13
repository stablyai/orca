import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000
const SCREENSHOT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const SCREENSHOT_CLEANUP_MARKER = '.last-cleanup'
const SCREENSHOT_FILE_SUFFIX = /-screenshot\.(png|jpg|img)$/

export type CliScreenshotTempDir = { envVar: string; dirName: string }

/** Saves a base64 screenshot where the CLI runs, so the agent can open it as an image. */
export function writeCliScreenshotTempFile(
  dir: CliScreenshotTempDir,
  requestId: string,
  data: string,
  extension: 'png' | 'jpg' | 'img'
): { path: string; expiresAt: string } {
  const outputDir = screenshotTempDir(dir)
  cleanupExpiredScreenshots(outputDir)
  const path = join(outputDir, `${safeCliFileStem(requestId)}-screenshot.${extension}`)
  writeFileSync(path, Buffer.from(data, 'base64'), { mode: 0o600 })
  return { path, expiresAt: new Date(Date.now() + SCREENSHOT_TTL_MS).toISOString() }
}

function screenshotTempDir(dir: CliScreenshotTempDir): string {
  const outputDir = process.env[dir.envVar] || join(tmpdir(), dir.dirName)
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(outputDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe screenshot temp path: ${outputDir}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Screenshot temp path is not owned by the current user: ${outputDir}`)
  }
  chmodSync(outputDir, 0o700)
  return outputDir
}

function cleanupExpiredScreenshots(outputDir: string): void {
  const now = Date.now()
  const markerPath = join(outputDir, SCREENSHOT_CLEANUP_MARKER)
  try {
    // Throttle synchronous cleanup scans across repeated screenshots.
    if (statSync(markerPath).mtimeMs > now - SCREENSHOT_CLEANUP_INTERVAL_MS) {
      return
    }
  } catch {
    // Missing or unreadable marker means this process should attempt cleanup.
  }

  const cutoff = now - SCREENSHOT_TTL_MS
  for (const entry of readdirSync(outputDir)) {
    if (!SCREENSHOT_FILE_SUFFIX.test(entry)) {
      continue
    }
    const path = join(outputDir, entry)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true })
      }
    } catch {
      // A raced temp file must not fail screenshot formatting.
    }
  }
  try {
    writeFileSync(markerPath, `${now}\n`, { mode: 0o600 })
  } catch {
    // A failed cleanup marker must not hide the screenshot.
  }
}

function safeCliFileStem(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}
