import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserUserAgentMode } from '../../shared/browser-user-agent-mode'

/**
 * The browser's identity is one process-wide decision, not a per-profile one.
 *
 * Electron resolves worker identity from a single process-global default, so two coherent
 * identities cannot coexist in one process: a per-profile native mode leaves documents on one
 * identity and every worker request on the other, which is a sharper bot signal than either
 * alone. The choice therefore lives here, is read before `ready`, and applies to the whole app.
 *
 * Both identities are load-bearing, which is why this is a choice and not a constant. Measured
 * across four origins, five repetitions each: the cleaned identity clears an embedded Turnstile
 * widget and WhatsApp's browser check while the native identity is refused by both; the native
 * identity clears a full-page Cloudflare interstitial that the cleaned identity never clears.
 *
 * Read with `readFileSync` rather than through the settings store because the store loads long
 * after `ready`, and by then every session and worker has already taken its default.
 *
 * This module only reads. Every write goes through browser-identity-mode-store.ts, which is the
 * single writer — the two-authority bug this replaced came from a second place writing here.
 */
export const BROWSER_IDENTITY_MODE_FILE = 'browser-identity-mode.json'
export const BROWSER_IDENTITY_MODE_VERSION = 1

export type BrowserIdentityModeRecord = {
  version: typeof BROWSER_IDENTITY_MODE_VERSION
  mode: BrowserUserAgentMode
  explicitSelection: boolean
  migrationNoticePending: boolean
}

type HealthyBrowserIdentityModeReadResult = {
  state: 'missing' | 'valid'
  appliedMode: BrowserUserAgentMode
  configuredMode: BrowserUserAgentMode
  explicitSelection: boolean
  migrationNoticePending: boolean
}

type UnhealthyBrowserIdentityModeReadResult = {
  state: 'corrupt' | 'future' | 'unreadable'
  appliedMode: 'clean'
  configuredMode: null
  explicitSelection: null
  migrationNoticePending: null
}

type BrowserIdentityModeFileInput = {
  readonly version?: unknown
  readonly mode?: unknown
  readonly explicitSelection?: unknown
  readonly migrationNoticePending?: unknown
}

/** In-memory health of one read. Never persisted: the file holds a choice, not a state machine. */
export type BrowserIdentityModeReadResult =
  | HealthyBrowserIdentityModeReadResult
  | UnhealthyBrowserIdentityModeReadResult

export function browserIdentityModeRecordPath(userDataPath: string): string {
  return join(userDataPath, BROWSER_IDENTITY_MODE_FILE)
}

function unhealthyResult(
  state: UnhealthyBrowserIdentityModeReadResult['state']
): UnhealthyBrowserIdentityModeReadResult {
  return {
    state,
    appliedMode: 'clean',
    configuredMode: null,
    explicitSelection: null,
    migrationNoticePending: null
  }
}

function parseRecord(raw: string): BrowserIdentityModeReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unhealthyResult('corrupt')
  }
  if (!isBrowserIdentityModeFileInput(parsed)) {
    return unhealthyResult('corrupt')
  }
  const { version, mode, explicitSelection, migrationNoticePending } = parsed
  // Why before the shape check: newer data means "update Orca", never "your data is broken".
  if (typeof version === 'number' && version > BROWSER_IDENTITY_MODE_VERSION) {
    return unhealthyResult('future')
  }
  if (
    version !== BROWSER_IDENTITY_MODE_VERSION ||
    (mode !== 'clean' && mode !== 'native') ||
    typeof explicitSelection !== 'boolean' ||
    typeof migrationNoticePending !== 'boolean'
  ) {
    return unhealthyResult('corrupt')
  }
  return {
    state: 'valid',
    appliedMode: mode,
    configuredMode: mode,
    explicitSelection,
    migrationNoticePending
  }
}

/** Reads the process identity synchronously before Electron readiness. */
export function readBrowserIdentityModeRecord(userDataPath: string): BrowserIdentityModeReadResult {
  try {
    return parseRecord(readFileSync(browserIdentityModeRecordPath(userDataPath), 'utf-8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {
        state: 'missing',
        appliedMode: 'clean',
        configuredMode: 'clean',
        explicitSelection: false,
        migrationNoticePending: false
      }
    }
    return unhealthyResult('unreadable')
  }
}

function isBrowserIdentityModeFileInput(value: unknown): value is BrowserIdentityModeFileInput {
  return typeof value === 'object' && value !== null
}
