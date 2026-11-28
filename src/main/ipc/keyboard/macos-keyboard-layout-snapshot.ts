import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  KeyboardLayoutKeyCharacters,
  KeyboardLayoutSnapshot
} from '../../../shared/keybindings/keyboard-layout-snapshot'

const HELPER_EXECUTABLE = 'orca-keyboard-layout'
const HELPER_TIMEOUT_MS = 1000
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024

let cachedHelperPath: Promise<string | null> | undefined
let readInFlight: Promise<KeyboardLayoutSnapshot | null> | null = null

// Why no existence check: the quit-chord watch spawns this path, and a missing helper fails closed there.
export function resolveMacKeyboardHelperPath(): string | null {
  return process.platform === 'darwin' ? join(dirname(process.execPath), HELPER_EXECUTABLE) : null
}

function resolveHelperPath(): Promise<string | null> {
  if (cachedHelperPath === undefined) {
    const candidate = resolveMacKeyboardHelperPath()
    cachedHelperPath = candidate
      ? access(candidate).then(
          () => candidate,
          () => null
        )
      : Promise.resolve(null)
  }
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
  readInFlight ??= resolveHelperPath()
    .then((helperPath) => (helperPath ? runHelper(helperPath) : null))
    .finally(() => {
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
