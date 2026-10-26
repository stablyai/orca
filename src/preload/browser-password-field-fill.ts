/**
 * Applies one fill main handed the guest: re-checks the target fields are still there, visible
 * and editable, then writes values the way a framework's controlled input will notice.
 */
import type {
  BrowserPasswordFillRequest,
  BrowserPasswordFillResult
} from '../shared/browser-passwords-types'
import { isPlaceholderUsernameValue } from './browser-password-field-rules'
import type { BrowserPasswordFormScanner } from './browser-password-form-scan'

type FillRefusal = NonNullable<BrowserPasswordFillResult['reason']>

export type BrowserPasswordFillContext = {
  scanner: BrowserPasswordFormScanner
  resolveField: (fieldToken: string) => HTMLInputElement | null
  recordFilledValue: (input: HTMLInputElement, value: string) => void
}

const MIN_FILL_SIZE_PX = 10
const MIN_EFFECTIVE_OPACITY = 0.1

export function isBrowserPasswordFillRequest(value: unknown): value is BrowserPasswordFillRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate: Record<string, unknown> = { ...value }
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.fieldToken === 'string' &&
    typeof candidate.password === 'string' &&
    (candidate.username === null || typeof candidate.username === 'string')
  )
}

function parentAcrossShadow(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement
  }
  const root = element.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

function hasVisibleStyleChain(input: HTMLInputElement): boolean {
  // Why the input alone for visibility: it inherits, so the computed value already covers ancestors.
  if (getComputedStyle(input).visibility === 'hidden') {
    return false
  }
  let opacity = 1
  for (let element: Element | null = input; element; element = parentAcrossShadow(element)) {
    const style = getComputedStyle(element)
    if (style.display === 'none') {
      return false
    }
    const own = Number.parseFloat(style.opacity)
    opacity *= Number.isFinite(own) ? own : 1
    if (opacity < MIN_EFFECTIVE_OPACITY) {
      return false
    }
  }
  return true
}

/** Why a hit test: a transparent overlay or off-screen field would take the password unseen. */
function isTopmostAtCentre(input: HTMLInputElement, rect: DOMRect): boolean {
  const root = input.getRootNode()
  const scope = root instanceof ShadowRoot ? root : input.ownerDocument
  const hit = scope.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  if (!hit) {
    return false
  }
  if (hit === input || input.contains(hit)) {
    return true
  }
  return Array.from(input.labels ?? []).some((label) => label === hit || label.contains(hit))
}

function isSameUsername(current: string, chosen: string): boolean {
  return current.trim().toLowerCase() === chosen.trim().toLowerCase()
}

function refusalFor(input: HTMLInputElement): FillRefusal | null {
  if (!input.isConnected) {
    return 'field-gone'
  }
  if (input.disabled || input.readOnly) {
    return 'not-editable'
  }
  const rect = input.getBoundingClientRect()
  if (rect.width < MIN_FILL_SIZE_PX || rect.height < MIN_FILL_SIZE_PX) {
    return 'not-visible'
  }
  return hasVisibleStyleChain(input) && isTopmostAtCentre(input, rect) ? null : 'not-visible'
}

function writeValue(input: HTMLInputElement, value: string): void {
  input.focus()
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set
  // Why the prototype setter: React and Vue track the last value they set on the instance, and
  // only a value written past that tracker makes their input handler see a change.
  if (nativeValueSetter) {
    nativeValueSetter.call(input, value)
  } else {
    input.value = value
  }
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

export function applyBrowserPasswordFill(
  request: BrowserPasswordFillRequest,
  context: BrowserPasswordFillContext
): BrowserPasswordFillResult {
  const refuse = (reason: FillRefusal): BrowserPasswordFillResult => ({
    requestId: request.requestId,
    ok: false,
    reason
  })
  const target = context.resolveField(request.fieldToken)
  const form = target?.isConnected ? context.scanner.scanFormOf(target) : null
  if (!target || !form) {
    return refuse('field-gone')
  }
  const { parsed } = form
  const passwordInputs = [parsed.password, parsed.newPassword, parsed.confirmPassword].map(
    (field) => field?.element ?? null
  )
  const usernameInput = parsed.username?.element ?? null
  if (target !== usernameInput && !passwordInputs.includes(target)) {
    return refuse('field-gone')
  }
  const passwordInput = passwordInputs.includes(target)
    ? target
    : (parsed.password?.element ?? parsed.newPassword?.element ?? null)

  if (!passwordInput) {
    // Why: a username-first step has no password box; fill just the username the user picked.
    if (!usernameInput || request.username === null) {
      return { requestId: request.requestId, ok: true }
    }
    const refusal = refusalFor(usernameInput)
    if (refusal) {
      return refuse(refusal)
    }
    writeValue(usernameInput, request.username)
    context.recordFilledValue(usernameInput, request.username)
    return { requestId: request.requestId, ok: true }
  }

  const refusal = refusalFor(passwordInput)
  if (refusal) {
    return refuse(refusal)
  }
  if (
    request.username !== null &&
    usernameInput &&
    !isSameUsername(usernameInput.value, request.username)
  ) {
    if (refusalFor(usernameInput) === null) {
      writeValue(usernameInput, request.username)
      context.recordFilledValue(usernameInput, request.username)
      // Why again: the username's focus and input events run page code that can hide or swap this box.
      const afterUsername = refusalFor(passwordInput)
      if (afterUsername) {
        return refuse(afterUsername)
      }
    } else if (!isPlaceholderUsernameValue(usernameInput.value)) {
      // Why refuse: this password beside a username we can't change would pair two accounts.
      return refuse('username-mismatch')
    }
  }
  writeValue(passwordInput, request.password)
  context.recordFilledValue(passwordInput, request.password)
  return { requestId: request.requestId, ok: true }
}
