import os from 'node:os'

const MAX_DIAGNOSTIC_LENGTH = 1_024
// Alternatives in order: CSI; string sequences whose payload must also be dropped; remaining two-byte escapes.
const ANSI_ESCAPE = new RegExp(
  [
    String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`,
    String.raw`\u001b[\]P^_X][^\u0007\u001b]*(?:\u0007|\u001b\\)?`,
    String.raw`\u001b[@-~]`
  ].join('|'),
  'g'
)
const CONTROL_CHARACTERS = new RegExp(String.raw`[\u0000-\u001f\u007f]`, 'g')
const MIN_REDACTED_USERNAME_LENGTH = 3

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

function readUserName(): string | null {
  try {
    return os.userInfo().username || null
  } catch {
    return null
  }
}

function replaceAllLiteral(text: string, needle: string, replacement: string): string {
  return needle.length === 0 ? text : text.split(needle).join(replacement)
}

/** Removes terminal escapes and local identity from updater text before showing it in the UI. */
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
  // Why: privilege tools can name the user without including their home directory.
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

export function createUpdaterDiagnosticLogger(): {
  info: (message: unknown) => void
  warn: (message: unknown) => void
  error: (message: unknown) => void
  debug: (message: unknown) => void
} {
  return {
    info: (message) => console.info('[autoUpdater]', message),
    warn: (message) => console.warn('[autoUpdater]', message),
    error: (message) => console.error('[autoUpdater]', message),
    debug: (message) => console.debug('[autoUpdater]', message)
  }
}
