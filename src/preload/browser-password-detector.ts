/**
 * Orca Vault's in-page half. Runs in the guest's isolated world and exposes nothing to page
 * script: it only describes credential forms, reports what the user typed and submitted, and
 * applies a fill main hands it. Main owns origins and every decision.
 */
import type {
  BrowserPasswordGuestCapture,
  BrowserPasswordGuestPageForms
} from '../shared/browser-passwords-types'
import { createBrowserPasswordElementTokens } from './browser-password-element-tokens'
import {
  applyBrowserPasswordFill,
  isBrowserPasswordFillRequest
} from './browser-password-field-fill'
import { createBrowserPasswordFocusTracker } from './browser-password-focus-tracker'
import {
  createBrowserPasswordFormScanner,
  fieldRoleOf,
  formRootOf,
  inputFromEvent,
  type DomPasswordField,
  type ScannedPasswordForm
} from './browser-password-form-scan'
import {
  PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS,
  PRELOAD_BROWSER_PASSWORDS_TO_GUEST_CHANNELS
} from './browser-password-guest-channels'
import type { BrowserPasswordGuestPort } from './browser-password-guest-port'
import { createBrowserPasswordSubmitTracker } from './browser-password-submit-tracker'

const TYPED_DEBOUNCE_MS = 300
const DOM_CHECK_DELAY_MS = 500
const PENDING_ADDED_NODE_LIMIT = 200
const OBSERVER_OPTIONS: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeOldValue: true,
  // Why these: `type` keeps show-password toggles classified; the rest change visibility.
  attributeFilter: ['type', 'style', 'class', 'hidden', 'disabled']
}

type RunningDetector = { fill: (payload: unknown) => void; stop: () => void }

function startDetector(port: BrowserPasswordGuestPort): RunningDetector {
  // Why only these values: page script can write any DOM value; only trusted input or our own fill is the user's.
  const trackedValues = new WeakMap<HTMLInputElement, string>()
  const valueOf = (input: HTMLInputElement): string => trackedValues.get(input) ?? ''
  const scanner = createBrowserPasswordFormScanner(valueOf)
  const fieldTokens = createBrowserPasswordElementTokens<HTMLInputElement>()
  let muted = false

  const trackedValueOf = (field: DomPasswordField | null): string | null =>
    field ? trackedValues.get(field.element) || null : null
  const captureOf = (form: ScannedPasswordForm): BrowserPasswordGuestCapture => ({
    ...scanner.summaryOf(form),
    username: trackedValueOf(form.parsed.username),
    password: trackedValueOf(form.parsed.password),
    newPassword: trackedValueOf(form.parsed.newPassword)
  })

  let typedTimer: ReturnType<typeof setTimeout> | null = null
  let typedInput: HTMLInputElement | null = null
  const flushTyped = (): void => {
    if (typedTimer !== null) {
      clearTimeout(typedTimer)
      typedTimer = null
    }
    const input = typedInput
    typedInput = null
    const form = input?.isConnected ? scanner.scanFormOf(input) : null
    if (input && form && fieldRoleOf(form, input)) {
      port.send(PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS.typed, captureOf(form))
    }
  }
  const onInput = (event: Event): void => {
    const input = event.isTrusted ? inputFromEvent(event) : null
    if (!input) {
      return
    }
    trackedValues.set(input, input.value)
    if (typedInput && typedInput !== input && formRootOf(typedInput) !== formRootOf(input)) {
      flushTyped()
    }
    typedInput = input
    if (typedTimer !== null) {
      clearTimeout(typedTimer)
    }
    typedTimer = setTimeout(flushTyped, TYPED_DEBOUNCE_MS)
  }

  const submits = createBrowserPasswordSubmitTracker({ port, scanner, captureOf, flushTyped })
  const focus = createBrowserPasswordFocusTracker({
    port,
    scanner,
    tokenFor: fieldTokens.tokenFor,
    isMuted: () => muted
  })

  let lastPageForms = JSON.stringify([])
  const snapshotPageForms = (): void => {
    const payload: BrowserPasswordGuestPageForms = {
      forms: scanner.hasAnyInput() ? scanner.scan().map(scanner.summaryOf) : []
    }
    const serialized = JSON.stringify(payload.forms)
    if (serialized !== lastPageForms) {
      lastPageForms = serialized
      port.send(PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS.pageForms, payload)
    }
  }

  let domCheckTimer: ReturnType<typeof setTimeout> | null = null
  const pendingAddedNodes: Node[] = []
  let addedNodesOverflowed = false
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.attributeName === 'type' && record.target instanceof HTMLInputElement) {
          scanner.noteTypeChange(record.target, record.oldValue)
        }
      } else if (pendingAddedNodes.length + record.addedNodes.length <= PENDING_ADDED_NODE_LIMIT) {
        pendingAddedNodes.push(...record.addedNodes)
      } else {
        addedNodesOverflowed = true
      }
    }
    // Why not re-armed per batch: a page that never stops mutating would otherwise never be checked.
    domCheckTimer ??= setTimeout(runDomCheck, DOM_CHECK_DELAY_MS)
  })
  const observeShadowRoots = (node: Node): void => {
    for (const root of scanner.discoverShadowRoots(node)) {
      observer.observe(root, OBSERVER_OPTIONS)
    }
  }
  function runDomCheck(): void {
    domCheckTimer = null
    const added = addedNodesOverflowed ? [document] : pendingAddedNodes.splice(0)
    pendingAddedNodes.length = 0
    addedNodesOverflowed = false
    for (const node of added) {
      if (node === document || (node.isConnected && node.nodeType === Node.ELEMENT_NODE)) {
        observeShadowRoots(node)
      }
    }
    submits.checkFormGone()
    snapshotPageForms()
  }

  const fill = (payload: unknown): void => {
    if (!isBrowserPasswordFillRequest(payload)) {
      return
    }
    muted = true
    try {
      const result = applyBrowserPasswordFill(payload, {
        scanner,
        resolveField: fieldTokens.resolve,
        recordFilledValue: (input, value) => trackedValues.set(input, value)
      })
      port.send(PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS.fillResult, result)
    } finally {
      muted = false
    }
    focus.clear()
  }

  scanner.notePasswordInputs(document.querySelectorAll('input'))
  observer.observe(document, OBSERVER_OPTIONS)
  observeShadowRoots(document)
  // Why capture: page handlers must not be able to stop these before we see them.
  document.addEventListener('input', onInput, true)
  document.addEventListener('submit', submits.onSubmit, true)
  document.addEventListener('keydown', submits.onKeyDown, true)
  document.addEventListener('click', submits.onClick, true)
  document.addEventListener('focusin', focus.onFocusIn, true)
  document.addEventListener('focusout', focus.onFocusOut, true)
  domCheckTimer = setTimeout(runDomCheck, DOM_CHECK_DELAY_MS)

  const stop = (): void => {
    observer.disconnect()
    document.removeEventListener('input', onInput, true)
    document.removeEventListener('submit', submits.onSubmit, true)
    document.removeEventListener('keydown', submits.onKeyDown, true)
    document.removeEventListener('click', submits.onClick, true)
    document.removeEventListener('focusin', focus.onFocusIn, true)
    document.removeEventListener('focusout', focus.onFocusOut, true)
    for (const timer of [typedTimer, domCheckTimer]) {
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
    // Why not flushed: once off, nothing typed may leave the page.
    typedInput = null
    focus.clear()
  }
  return { fill, stop }
}

/** Until main enables this document, the only things installed are these three listeners. */
export function installBrowserPasswordDetector(port: BrowserPasswordGuestPort): void {
  // Why: subframes never get this preload today; refuse anyway so a policy change can't widen it.
  if (window.top !== window) {
    return
  }
  let running: RunningDetector | null = null
  port.on(PRELOAD_BROWSER_PASSWORDS_TO_GUEST_CHANNELS.enable, () => {
    running ??= startDetector(port)
  })
  port.on(PRELOAD_BROWSER_PASSWORDS_TO_GUEST_CHANNELS.disable, () => {
    running?.stop()
    running = null
  })
  port.on(PRELOAD_BROWSER_PASSWORDS_TO_GUEST_CHANNELS.fill, (payload) => running?.fill(payload))
}
