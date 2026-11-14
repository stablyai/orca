import type {
  BrowserPasswordFillResult,
  BrowserPasswordFormKind,
  BrowserPasswordFormSummary,
  BrowserPasswordGuestCapture,
  BrowserPasswordGuestFieldFocused,
  BrowserPasswordGuestRect,
  BrowserPasswordGuestSubmitted
} from '../../shared/browser-passwords-types'

// Why every guest payload is re-checked here: the preload runs in a page process that page code
// may have compromised, so main treats its messages as untrusted input.

const FORM_KINDS: readonly string[] = [
  'login',
  'signup',
  'change',
  'username-only'
] satisfies BrowserPasswordFormKind[]
const MAX_SHORT_TEXT = 2048
const MAX_SECRET_TEXT = 1000
const MAX_FORMS = 50

type Payload = Record<string, unknown>

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isOptionalText(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max)
}

function isFormKind(value: unknown): value is BrowserPasswordFormKind {
  return typeof value === 'string' && FORM_KINDS.includes(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readRect(value: unknown): BrowserPasswordGuestRect | null {
  if (!isRecord(value)) {
    return null
  }
  const { x, y, width, height } = value
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height)
    ? { x, y, width, height }
    : null
}

export function readBrowserPasswordFormSummary(value: unknown): BrowserPasswordFormSummary | null {
  if (!isRecord(value)) {
    return null
  }
  const { formSignature, kind, usernameFieldName, passwordFieldName, action } = value
  if (
    !isText(formSignature, MAX_SHORT_TEXT) ||
    !isFormKind(kind) ||
    !isOptionalText(usernameFieldName, MAX_SHORT_TEXT) ||
    !isOptionalText(passwordFieldName, MAX_SHORT_TEXT) ||
    !isOptionalText(action, MAX_SHORT_TEXT)
  ) {
    return null
  }
  return {
    formSignature,
    kind,
    usernameFieldName,
    passwordFieldName,
    action
  }
}

export function readBrowserPasswordFormSummaries(
  value: unknown
): BrowserPasswordFormSummary[] | null {
  if (!isRecord(value) || !Array.isArray(value.forms) || value.forms.length > MAX_FORMS) {
    return null
  }
  const forms = value.forms.map(readBrowserPasswordFormSummary)
  return forms.every((form) => form !== null) ? forms : null
}

export function readBrowserPasswordCapture(value: unknown): BrowserPasswordGuestCapture | null {
  const summary = readBrowserPasswordFormSummary(value)
  if (!summary || !isRecord(value)) {
    return null
  }
  const { username, password, newPassword } = value
  if (
    !isOptionalText(username, MAX_SECRET_TEXT) ||
    !isOptionalText(password, MAX_SECRET_TEXT) ||
    !isOptionalText(newPassword, MAX_SECRET_TEXT)
  ) {
    return null
  }
  return {
    ...summary,
    username: username || null,
    password: password || null,
    newPassword: newPassword || null
  }
}

export function readBrowserPasswordSubmitted(value: unknown): BrowserPasswordGuestSubmitted | null {
  const capture = readBrowserPasswordCapture(value)
  if (!capture || !isRecord(value)) {
    return null
  }
  const { source } = value
  return source === 'submit' || source === 'enter' || source === 'button'
    ? { ...capture, source }
    : null
}

export function readBrowserPasswordFieldFocused(
  value: unknown
): BrowserPasswordGuestFieldFocused | null {
  if (!isRecord(value)) {
    return null
  }
  const { fieldToken, formSignature, role, viewportWidth } = value
  const rect = readRect(value.rect)
  if (
    !isText(fieldToken, MAX_SHORT_TEXT) ||
    !isText(formSignature, MAX_SHORT_TEXT) ||
    (role !== 'username' && role !== 'password' && role !== 'new-password') ||
    !isFiniteNumber(viewportWidth) ||
    !rect
  ) {
    return null
  }
  return { fieldToken, formSignature, role, rect, viewportWidth }
}

export function readBrowserPasswordToken(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null
  }
  const token = value[key]
  return isText(token, MAX_SHORT_TEXT) ? token : null
}

export function readBrowserPasswordFillResult(value: unknown): BrowserPasswordFillResult | null {
  if (!isRecord(value)) {
    return null
  }
  const { requestId, ok, reason } = value
  if (!isText(requestId, MAX_SHORT_TEXT) || typeof ok !== 'boolean') {
    return null
  }
  return reason === 'field-gone' ||
    reason === 'not-visible' ||
    reason === 'not-editable' ||
    reason === 'username-mismatch'
    ? { requestId, ok, reason }
    : { requestId, ok }
}
