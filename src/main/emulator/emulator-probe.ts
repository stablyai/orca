import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Diagnostic probes for emulator bring-up. They are opt-in because command
// params can include typed text, package names, and local paths.
export const EMULATOR_PROBE_LOG = join(tmpdir(), 'orca-android-emu-probe.log')
const EMULATOR_PROBE_ENABLED = process.env.ORCA_EMULATOR_PROBE === '1'

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

function format(level: string, event: string, data?: unknown): string {
  let payload = ''
  if (data !== undefined) {
    try {
      payload = ` ${JSON.stringify(data)}`
    } catch {
      payload = ' [unserializable]'
    }
  }
  return `${new Date().toISOString()} [emu:${level}] ${event}${payload}`
}

function append(text: string): void {
  try {
    appendFileSync(EMULATOR_PROBE_LOG, `${text}\n`)
  } catch {
    // Best-effort: never let logging break the feature.
  }
}

export function emulatorProbe(event: string, data?: unknown): void {
  if (!EMULATOR_PROBE_ENABLED) {
    return
  }
  const text = format('info', event, data)
  console.log(text)
  append(text)
}

export function emulatorProbeError(event: string, error: unknown, data?: unknown): void {
  if (!EMULATOR_PROBE_ENABLED) {
    return
  }
  const detail = {
    ...(data && typeof data === 'object' ? (data as Record<string, unknown>) : {}),
    error: errorMessage(error)
  }
  const text = format('error', event, detail)
  console.error(text)
  append(text)
}
