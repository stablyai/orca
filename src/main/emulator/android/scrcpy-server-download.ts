import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { get } from 'node:https'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage } from 'node:http'
import { EmulatorError } from '../emulator-errors'
import { emulatorProbe, emulatorProbeError } from '../emulator-probe'
import { SCRCPY_SERVER_VERSION } from './scrcpy-server-deploy'

// The scrcpy server jar is fetched by the client on first use (not bundled in
// the repo) into the per-user cache, pinned to the version our client protocol
// targets. The GitHub release asset is unversioned-extension, so we store it as .jar.
const DOWNLOAD_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_SERVER_VERSION}/scrcpy-server-v${SCRCPY_SERVER_VERSION}`
const MIN_VALID_BYTES = 10_000

export function scrcpyServerJarPath(): string {
  return join(app.getPath('userData'), 'scrcpy', `scrcpy-server-v${SCRCPY_SERVER_VERSION}.jar`)
}

export function isScrcpyServerJarReady(): boolean {
  try {
    const path = scrcpyServerJarPath()
    return existsSync(path) && statSync(path).size >= MIN_VALID_BYTES
  } catch {
    return false
  }
}

let inFlightDownload: Promise<string> | null = null

// Returns the cached jar path, downloading it once if missing. Concurrent callers
// (e.g. two devices on first run) share one download. Throws a clear
// EmulatorError when the download fails (e.g. offline).
export async function ensureScrcpyServerJar(): Promise<string> {
  const path = scrcpyServerJarPath()
  if (isScrcpyServerJarReady()) {
    return path
  }
  if (!inFlightDownload) {
    inFlightDownload = downloadScrcpyServerJar(path).finally(() => {
      inFlightDownload = null
    })
  }
  return inFlightDownload
}

async function downloadScrcpyServerJar(path: string): Promise<string> {
  emulatorProbe('scrcpy.jar.download.start', { url: DOWNLOAD_URL, dest: path })
  mkdirSync(dirname(path), { recursive: true })
  try {
    await downloadTo(DOWNLOAD_URL, path)
  } catch (error) {
    rmSync(path, { force: true })
    emulatorProbeError('scrcpy.jar.download.fail', error, { url: DOWNLOAD_URL })
    const detail = error instanceof Error ? error.message : 'unknown error'
    throw new EmulatorError('emulator_helper_failed', `Could not download scrcpy server: ${detail}`)
  }
  if (!isScrcpyServerJarReady()) {
    rmSync(path, { force: true })
    throw new EmulatorError(
      'emulator_helper_failed',
      'Downloaded scrcpy server was invalid or truncated.'
    )
  }
  emulatorProbe('scrcpy.jar.download.ok', { dest: path, bytes: statSync(path).size })
  return path
}

function downloadTo(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'))
      return
    }
    const req = get(url, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0
      // GitHub release downloads 302-redirect to the asset CDN.
      if (status >= 300 && status < 400 && res.headers.location) {
        // Resolve relative Locations and refuse protocol downgrades (http:).
        const next = new URL(res.headers.location, url)
        if (next.protocol !== 'https:') {
          res.resume()
          reject(new Error(`refusing non-https redirect to ${next.protocol}`))
          return
        }
        res.resume()
        downloadTo(next.toString(), dest, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      // pipeline destroys the write stream and rejects on any stream error
      // (incl. mid-body errors on res), so the Promise always settles.
      pipeline(res, createWriteStream(dest)).then(resolve, reject)
    })
    req.on('error', reject)
    // Don't hang forever if GitHub/CDN stalls before or during the response.
    req.setTimeout(30_000, () => req.destroy(new Error('download timed out')))
  })
}
