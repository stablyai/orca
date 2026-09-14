import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  KeyboardLayoutKeyCharacters,
  KeyboardLayoutSnapshot
} from '../../shared/keyboard-layout-snapshot'

const HELPER_EXECUTABLE = 'orca-keyboard-layout'
const HELPER_TIMEOUT_MS = 1000
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024

let cachedHelperPath: string | null | undefined
let readInFlight: Promise<KeyboardLayoutSnapshot | null> | null = null

function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) {
    return cachedHelperPath
  }
  if (process.platform !== 'darwin') {
    cachedHelperPath = null
    return cachedHelperPath
  }
  const candidate = join(dirname(process.execPath), HELPER_EXECUTABLE)
  cachedHelperPath = existsSync(candidate) ? candidate : null
  return cachedHelperPath
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function parseKeyboardLayoutSnapshot(stdout: string): KeyboardLayoutSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (!record.keyCharacters || typeof record.keyCharacters !== 'object') {
    return null
  }
  const keyCharacters: Record<string, KeyboardLayoutKeyCharacters> = {}
  for (const [code, value] of Object.entries(record.keyCharacters)) {
    if (!value || typeof value !== 'object') {
      continue
    }
    const characters = value as Record<string, unknown>
    keyCharacters[code] = {
      unmodified: optionalString(characters.unmodified),
      shifted: optionalString(characters.shifted)
    }
  }
  return {
    inputSourceId: optionalString(record.inputSourceId),
    layoutSourceId: optionalString(record.layoutSourceId),
    keyCharacters
  }
}

export function readMacKeyboardLayoutSnapshot(): Promise<KeyboardLayoutSnapshot | null> {
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return Promise.resolve(null)
  }
  if (readInFlight) {
    return readInFlight
  }
  readInFlight = runHelper(helperPath).finally(() => {
    readInFlight = null
  })
  return readInFlight
}

export async function waitForMacKeyboardLayoutSnapshotIdle(): Promise<void> {
  while (readInFlight) {
    await readInFlight
  }
}

function runHelper(helperPath: string): Promise<KeyboardLayoutSnapshot | null> {
  return new Promise((resolve) => {
    execFile(
      helperPath,
      [],
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_HELPER_OUTPUT_BYTES },
      (error, stdout) => {
        resolve(error ? null : parseKeyboardLayoutSnapshot(String(stdout).trim()))
      }
    )
  })
}
