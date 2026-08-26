import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

// Default landing spot for screen recordings started without an explicit path.
export const EMULATOR_RECORDINGS_DIR_NAME = 'emulator-recordings'

function sanitizeDeviceSegment(deviceName: string): string {
  const sanitized = deviceName
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || 'emulator'
}

function timestampSegment(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[:T]/g, '-')
}

export function buildEmulatorRecordingFileName(deviceName: string, date = new Date()): string {
  return `orca-${sanitizeDeviceSegment(deviceName)}-${timestampSegment(date)}.mp4`
}

// Relative paths resolve against the recordings directory so a bare
// `--path demo.mp4` never lands in whatever cwd the runtime happens to have.
export function resolveEmulatorRecordingPath(
  recordingsDir: string,
  deviceName: string,
  requestedPath?: string,
  date = new Date()
): string {
  if (!requestedPath) {
    return join(recordingsDir, buildEmulatorRecordingFileName(deviceName, date))
  }
  return isAbsolute(requestedPath) ? requestedPath : join(recordingsDir, requestedPath)
}

export async function ensureEmulatorRecordingsDir(userDataDir: string): Promise<string> {
  const dir = join(userDataDir, EMULATOR_RECORDINGS_DIR_NAME)
  await mkdir(dir, { recursive: true })
  return dir
}
