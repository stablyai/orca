import os from 'node:os'
import type { LinuxPackageInstallFailureReason } from '../shared/update-status-types'

/** The redacted text shown locally, paired with the reason classified from the ORIGINAL output. */
export type LinuxPackageInstallDiagnostic = {
  message: string
  reason: LinuxPackageInstallFailureReason
}

const MAX_DIAGNOSTIC_LENGTH = 1_024
// Built via RegExp so the source carries no raw control bytes. Alternatives in order: CSI; then the
// string sequences (OSC/DCS/PM/APC/SOS), whose payload — an OSC 8 hyperlink URL, say — must be
// dropped with the introducer rather than left behind; then any remaining two-byte escape.
const ANSI_ESCAPE = new RegExp(
  [
    String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`,
    String.raw`\u001b[\]P^_X][^\u0007\u001b]*(?:\u0007|\u001b\\)?`,
    String.raw`\u001b[@-~]`
  ].join('|'),
  'g'
)
const CONTROL_CHARACTERS = new RegExp(String.raw`[\u0000-\u001f\u007f]`, 'g')

// Why: pkexec/polkit print these before any package manager runs; matching them keeps the UI from
// blaming dpkg for an authentication problem. Anything else stays generic on purpose.
const AGENT_UNAVAILABLE_PATTERNS = [
  /no authentication agent/i,
  /polkit.{0,20}agent.{0,20}not found/i
]
const AUTHENTICATION_DENIED_PATTERNS = [
  /request dismissed/i,
  /authentication failed/i,
  /not authorized/i,
  /authorization failed/i,
  /incorrect password attempt/i
]

let capturing = false
let retainedDiagnostic: string | null = null
// Why: classification must read the ORIGINAL text. Redaction can rewrite a pattern word — a user
// named "age" turns "No authentication agent found" into "No authentication <user>nt" — which would
// silently downgrade a missing-agent failure to the generic reason.
let retainedReason: LinuxPackageInstallFailureReason | null = null
let redactedPackagePath: string | null = null

function stringifyLoggerValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Error) {
    return value.message
  }
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? ''
    } catch {
      return ''
    }
  }
  return String(value)
}

// Short names would corrupt unrelated words, so they are left alone.
const MIN_REDACTED_USERNAME_LENGTH = 3

function readUserName(): string | null {
  try {
    return os.userInfo().username || null
  } catch {
    return null
  }
}

function replaceAllLiteral(text: string, needle: string, replacement: string): string {
  if (needle.length === 0) {
    return text
  }
  return text.split(needle).join(replacement)
}

/**
 * Turns arbitrary updater/child output into text safe to show locally: no ANSI, no control bytes,
 * no home directory, no cached package path, bounded length.
 */
export function redactLinuxPackageInstallText(
  value: unknown,
  packagePath: string | null
): string | null {
  const raw = stringifyLoggerValue(value)
  if (raw.length === 0) {
    return null
  }
  let text = raw.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARACTERS, ' ')
  if (packagePath) {
    text = replaceAllLiteral(text, packagePath, '<package>')
  }
  const homeDir = os.homedir()
  if (homeDir) {
    text = replaceAllLiteral(text, homeDir, '<home>')
  }
  // Why: sudo reports "<user> is not in the sudoers file", which the home-directory rule cannot catch.
  const userName = readUserName()
  if (userName && userName.length >= MIN_REDACTED_USERNAME_LENGTH) {
    text = replaceAllLiteral(text, userName, '<user>')
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length === 0) {
    return null
  }
  return text.length > MAX_DIAGNOSTIC_LENGTH ? text.slice(0, MAX_DIAGNOSTIC_LENGTH) : text
}

/** Starts retaining redacted error output for one native root-package install attempt. */
export function beginLinuxPackageInstallDiagnosticCapture(packagePath: string | null): void {
  capturing = true
  retainedDiagnostic = null
  retainedReason = null
  redactedPackagePath = packagePath
}

/** Stops capture and hands back the retained diagnostic, clearing it for the next attempt. */
export function endLinuxPackageInstallDiagnosticCapture(): LinuxPackageInstallDiagnostic | null {
  const captured = getLinuxPackageInstallDiagnostic()
  capturing = false
  retainedDiagnostic = null
  retainedReason = null
  redactedPackagePath = null
  return captured
}

export function getLinuxPackageInstallDiagnostic(): LinuxPackageInstallDiagnostic | null {
  return retainedDiagnostic === null
    ? null
    : { message: retainedDiagnostic, reason: retainedReason ?? 'package-install-failed' }
}

function recordLinuxPackageInstallDiagnostic(value: unknown): void {
  if (!capturing) {
    return
  }
  const raw = stringifyLoggerValue(value)
  const redacted = redactLinuxPackageInstallText(raw, redactedPackagePath)
  if (!redacted) {
    return
  }
  const reason = classifyLinuxPackageInstallFailure(raw)
  // Why: electron-updater logs the polkit output first and a generic "exited with code N" line after,
  // so a later generic line must not erase the specific verdict the card branches on.
  if (
    reason === 'package-install-failed' &&
    retainedReason !== null &&
    retainedReason !== 'package-install-failed'
  ) {
    return
  }
  retainedDiagnostic = redacted
  retainedReason = reason
}

/**
 * The `autoUpdater.logger`. Every level still reaches the same console method; only error output
 * during an in-flight root-package install is retained, redacted, for the recovery card.
 */
export function createUpdaterDiagnosticLogger(): {
  info: (m: unknown) => void
  warn: (m: unknown) => void
  error: (m: unknown) => void
  debug: (m: unknown) => void
} {
  return {
    info: (m: unknown) => console.info('[autoUpdater]', m),
    warn: (m: unknown) => console.warn('[autoUpdater]', m),
    error: (m: unknown) => {
      recordLinuxPackageInstallDiagnostic(m)
      console.error('[autoUpdater]', m)
    },
    debug: (m: unknown) => console.debug('[autoUpdater]', m)
  }
}

export function classifyLinuxPackageInstallFailure(
  diagnostic: string | null
): LinuxPackageInstallFailureReason {
  if (!diagnostic) {
    return 'package-install-failed'
  }
  if (AGENT_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(diagnostic))) {
    return 'authentication-agent-unavailable'
  }
  if (AUTHENTICATION_DENIED_PATTERNS.some((pattern) => pattern.test(diagnostic))) {
    return 'authentication-denied'
  }
  // Localized or unrecognized output must never be reported as a missing agent.
  return 'package-install-failed'
}

/** Parses the child exit status out of electron-updater's `Command <x> exited with code <n>`. */
export function parseLinuxPackageInstallExitCode(error: unknown): number | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = /exited with code (-?\d{1,5})\b/i.exec(message)
  if (!match) {
    return null
  }
  const code = Number.parseInt(match[1], 10)
  return Number.isFinite(code) ? code : null
}
