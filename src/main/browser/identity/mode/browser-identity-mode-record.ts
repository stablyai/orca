import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_BROWSER_USER_AGENT_MODE,
  type BrowserUserAgentMode
} from '../../../../shared/browser/identity/browser-user-agent-mode'

/** Read synchronously before Electron ready: worker identity uses a process-global default. */
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
  appliedMode: typeof DEFAULT_BROWSER_USER_AGENT_MODE
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

/** Read health is transient; only the identity choice and migration flags are persisted. */
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
    appliedMode: DEFAULT_BROWSER_USER_AGENT_MODE,
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
  // Classify future versions before validating current-version fields.
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
  // Only an explicit choice pins a mode; otherwise follow the current default.
  const effectiveMode = explicitSelection ? mode : DEFAULT_BROWSER_USER_AGENT_MODE
  return {
    state: 'valid',
    appliedMode: effectiveMode,
    configuredMode: effectiveMode,
    explicitSelection,
    migrationNoticePending
  }
}

export function readBrowserIdentityModeRecord(userDataPath: string): BrowserIdentityModeReadResult {
  try {
    return parseRecord(readFileSync(browserIdentityModeRecordPath(userDataPath), 'utf-8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {
        state: 'missing',
        appliedMode: DEFAULT_BROWSER_USER_AGENT_MODE,
        configuredMode: DEFAULT_BROWSER_USER_AGENT_MODE,
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
