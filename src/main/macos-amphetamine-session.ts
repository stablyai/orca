import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'
import { runProcess } from '../shared/child-process/run-process'

export const AMPHETAMINE_BUNDLE_ID = 'com.if.Amphetamine'
export const MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS = 10_000

const OSASCRIPT = '/usr/bin/osascript'

/** Read the global session without launching Amphetamine or mutating it. */
export const AMPHETAMINE_SESSION_STATUS_SCRIPT = `if application id "${AMPHETAMINE_BUNDLE_ID}" is running then
	tell application id "${AMPHETAMINE_BUNDLE_ID}"
		if session is active then return "active"
		return "inactive"
	end tell
else
	return "inactive"
end if`

export const AMPHETAMINE_LOCATE_SCRIPT = `POSIX path of (path to application id "${AMPHETAMINE_BUNDLE_ID}")`

export type OsascriptResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type RunOsascript = (script: string, signal?: AbortSignal) => Promise<OsascriptResult>

export type AmphetamineSessionStatus = 'active' | 'inactive'

export function parseAmphetamineSessionStatus(stdout: string): AmphetamineSessionStatus | null {
  const value = stdout.trim()
  return value === 'active' || value === 'inactive' ? value : null
}

export function runOsascriptWithRunProcess(
  script: string,
  signal?: AbortSignal
): Promise<OsascriptResult> {
  return runProcess({
    program: OSASCRIPT,
    args: ['-e', script],
    timeoutMs: MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS,
    signal
  })
}

/**
 * Resolve the bundle through Launch Services.
 *
 * Returns undefined when the answer is unknown — a timeout, a spawn error, or an
 * unrecognized failure. Only a lookup that positively failed to resolve the
 * bundle reports false, because a caller that records false disables the engine
 * and would otherwise do so on a transient hiccup.
 */
export async function detectAmphetamineInstalled(
  runOsascriptImpl: RunOsascript = runOsascriptWithRunProcess,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal
): Promise<boolean | undefined> {
  if (platform !== 'darwin') {
    return false
  }
  let result: OsascriptResult
  try {
    result = await runOsascriptImpl(AMPHETAMINE_LOCATE_SCRIPT, signal)
  } catch {
    return undefined
  }
  if (result.timedOut) {
    return undefined
  }
  if (result.code === 0) {
    // Empty stdout on success is not a positive miss, so it is unknown too.
    return result.stdout.trim().length > 0 ? true : undefined
  }
  return classifyAmphetamineFailure(result) === 'not-installed' ? false : undefined
}

export function classifyAmphetamineFailure(
  result: OsascriptResult
): AmphetamineUnavailableReason | null {
  const text = `${result.stderr} ${result.stdout}`
  // -1728/-10814: Launch Services cannot resolve the bundle id, i.e. Amphetamine is not installed.
  if (text.includes('-1728') || text.includes('-10814')) {
    return 'not-installed'
  }
  // -1743/errAEEventNotPermitted: the user denied Orca's Automation grant for Amphetamine.
  if (text.includes('-1743') || text.includes('Not authorized to send Apple events')) {
    return 'automation-denied'
  }
  return null
}
