import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type NotificationAuthorizationStatus = 'authorized' | 'denied' | 'not-determined' | 'unknown'

const HELPER_EXECUTABLE = 'orca-notification-status'
const HELPER_TIMEOUT_MS = 4000

let cachedHelperPath: string | null | undefined

/**
 * Resolves the bundled notification-status helper binary.
 *
 * Why: the helper must live inside the app bundle — NSBundle resolves the
 * process's bundle by walking up from the executable path, and macOS keys
 * notification records to that identity. Both dev copies and packaged builds
 * place it next to the Electron executable in Contents/MacOS.
 */
function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) {
    return cachedHelperPath
  }
  if (process.platform !== 'darwin') {
    cachedHelperPath = null
    return cachedHelperPath
  }
  // Dev copies place the helper next to the Electron executable; packaged
  // builds ship it via extraResources. Both are inside the .app, which is
  // what NSBundle resolution requires.
  const candidates = [
    join(dirname(process.execPath), HELPER_EXECUTABLE),
    ...(process.resourcesPath ? [join(process.resourcesPath, HELPER_EXECUTABLE)] : [])
  ]
  cachedHelperPath = candidates.find((candidate) => existsSync(candidate)) ?? null
  return cachedHelperPath
}

/**
 * Reads the app's real macOS notification authorization via a helper binary
 * calling UNUserNotificationCenter.getNotificationSettings. Returns null when
 * the helper is unavailable or fails, so callers can fall back to weaker
 * delivery-probe evidence.
 *
 * Why a helper at all: Electron exposes no API for notification authorization
 * (scheduling silently succeeds even while macOS is suppressing display), so
 * the only truthful signal is the native settings read.
 */
let readInFlight: Promise<NotificationAuthorizationStatus | null> | null = null

export function readNotificationAuthorizationStatus(): Promise<NotificationAuthorizationStatus | null> {
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return Promise.resolve(null)
  }
  // Why: simultaneous agent completions across worktrees each consult the
  // readout — one in-flight helper run answers all of them.
  if (readInFlight) {
    return readInFlight
  }
  readInFlight = runStatusHelper(helperPath).finally(() => {
    readInFlight = null
  })
  return readInFlight
}

function runStatusHelper(helperPath: string): Promise<NotificationAuthorizationStatus | null> {
  return new Promise((resolve) => {
    execFile(helperPath, [], { timeout: HELPER_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(String(stdout).trim()) as { authorization?: string }
        switch (parsed.authorization) {
          case 'authorized':
          case 'provisional':
          case 'ephemeral':
            resolve('authorized')
            return
          case 'denied':
            resolve('denied')
            return
          case 'not-determined':
            resolve('not-determined')
            return
          default:
            resolve('unknown')
        }
      } catch {
        resolve(null)
      }
    })
  })
}
