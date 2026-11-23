import { runProcess } from '@orca/process-host'
import { parseScreenGeometry, type ScreenNotchGeometry } from './screen-geometry-protocol'
export type { ScreenNotchGeometry } from './screen-geometry-protocol'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

const HELPER_EXECUTABLE = 'orca-screen-geometry'
const HELPER_TIMEOUT_MS = 3000

let cachedHelperPath: Promise<string | null> | undefined

function resolveHelperPath(): Promise<string | null> {
  if (cachedHelperPath !== undefined) {
    return cachedHelperPath
  }
  if (process.platform !== 'darwin') {
    cachedHelperPath = Promise.resolve(null)
    return cachedHelperPath
  }
  const candidates = app.isPackaged
    ? [join(dirname(process.execPath), HELPER_EXECUTABLE)]
    : [
        join(dirname(process.execPath), HELPER_EXECUTABLE),
        join(
          app.getAppPath(),
          'native',
          'screen-geometry-macos',
          '.build',
          'release',
          HELPER_EXECUTABLE
        ),
        join(
          process.cwd(),
          'native',
          'screen-geometry-macos',
          '.build',
          'release',
          HELPER_EXECUTABLE
        )
      ]
  cachedHelperPath = (async () => {
    for (const candidate of candidates) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // A missing helper uses the capsule presentation.
      }
    }
    return null
  })()
  return cachedHelperPath
}

async function runHelper(helperPath: string): Promise<Map<number, ScreenNotchGeometry>> {
  try {
    const result = await runProcess({
      program: helperPath,
      args: [],
      timeoutMs: HELPER_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    return result.code === 0 && !result.outputTruncated
      ? parseScreenGeometry(result.stdout)
      : new Map()
  } catch {
    return new Map()
  }
}

let readInFlight: Promise<Map<number, ScreenNotchGeometry>> | null = null

export function readScreenGeometry(): Promise<Map<number, ScreenNotchGeometry>> {
  if (readInFlight) {
    return readInFlight
  }
  readInFlight = resolveHelperPath()
    .then((helperPath) =>
      helperPath ? runHelper(helperPath) : new Map<number, ScreenNotchGeometry>()
    )
    .finally(() => {
      readInFlight = null
    })
  return readInFlight
}
