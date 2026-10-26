/**
 * Reads credential forms out of the live DOM for the password detector: groups inputs by their
 * outermost `<form>` (one formless group per document), walks open shadow roots, and hands the
 * descriptors to the pure parser. All state stays in this closure, never on page elements.
 */
import type {
  BrowserPasswordFieldRole,
  BrowserPasswordFormSummary
} from '../shared/browser-passwords-types'
import { isCredentialInputType, type PasswordFieldDescriptor } from './browser-password-field-rules'
import {
  parsePasswordForm,
  passwordFieldRoleIn,
  type ParsedPasswordForm
} from './browser-password-form-parser'
import { createBrowserPasswordElementTokens } from './browser-password-element-tokens'

export type BrowserPasswordFormRoot = HTMLFormElement | Document

export type DomPasswordField = PasswordFieldDescriptor & { element: HTMLInputElement }

export type ScannedPasswordForm = {
  root: BrowserPasswordFormRoot
  signature: string
  parsed: ParsedPasswordForm<DomPasswordField>
}

export type BrowserPasswordFormScanner = {
  /** Records inputs that are password fields now, so a later show-password toggle keeps them one. */
  notePasswordInputs: (inputs: Iterable<HTMLInputElement>) => void
  noteTypeChange: (input: HTMLInputElement, oldType: string | null) => void
  /** Finds open shadow roots under `node`; returns the ones not seen before. */
  discoverShadowRoots: (node: Node) => ShadowRoot[]
  hasAnyInput: () => boolean
  scan: () => ScannedPasswordForm[]
  scanFormOf: (input: HTMLInputElement) => ScannedPasswordForm | null
  summaryOf: (form: ScannedPasswordForm) => BrowserPasswordFormSummary
}

const FORM_TEXT_LIMIT = 2000
const BUTTON_SELECTOR = 'button, input[type="submit"], input[type="button"], [role="button"]'
const FORMLESS_BUTTON_LIMIT = 30

/** True when laid out with a box and not hidden by style; ancestors' display:none collapses the box. */
export function isRenderedElement(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return false
  }
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

/** Why the composed path: at the document an event from a shadow-root input is retargeted to its host. */
export function inputFromEvent(event: Event): HTMLInputElement | null {
  const target = event.composedPath()[0]
  return target instanceof HTMLInputElement ? target : null
}

export function fieldRoleOf(
  form: ScannedPasswordForm,
  input: HTMLInputElement
): BrowserPasswordFieldRole | null {
  const { parsed } = form
  const field = [parsed.username, parsed.password, parsed.newPassword, parsed.confirmPassword].find(
    (candidate) => candidate?.element === input
  )
  return field ? passwordFieldRoleIn(parsed, field) : null
}

/** Outermost `<form>` around the input, across shadow boundaries; the document when formless. */
export function formRootOf(element: Element): BrowserPasswordFormRoot {
  let outermost: HTMLFormElement | null = null
  let node: Node | null = element
  while (node) {
    if (node instanceof HTMLFormElement) {
      outermost = node
    }
    node = node instanceof ShadowRoot ? node.host : node.parentNode
  }
  if (!outermost && element instanceof HTMLInputElement && element.form) {
    outermost = element.form
  }
  return outermost ?? element.ownerDocument
}

function controlText(element: Element): string {
  if (element instanceof HTMLInputElement) {
    return element.value
  }
  return `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`
}

function formTextOf(root: BrowserPasswordFormRoot): string {
  if (root instanceof HTMLFormElement) {
    const buttonValues = Array.from(
      root.querySelectorAll('input[type="submit"], input[type="button"]')
    )
      .map(controlText)
      .join(' ')
    return `${(root.textContent ?? '').slice(0, FORM_TEXT_LIMIT)} ${buttonValues}`.toLowerCase()
  }
  return Array.from(root.querySelectorAll(BUTTON_SELECTOR))
    .slice(0, FORMLESS_BUTTON_LIMIT)
    .map((button) => controlText(button).slice(0, 100))
    .join(' ')
    .toLowerCase()
}

function labelTextOf(input: HTMLInputElement): string {
  return Array.from(input.labels ?? [])
    .map((label) => label.textContent ?? '')
    .join(' ')
    .slice(0, 200)
}

function fieldNameOf(field: DomPasswordField | null): string | null {
  if (!field) {
    return null
  }
  return field.name || field.id || null
}

function actionOf(root: BrowserPasswordFormRoot): string | null {
  if (!(root instanceof HTMLFormElement)) {
    return null
  }
  const attribute = root.getAttribute('action')?.trim() ?? ''
  if (attribute === '' || /^javascript:/i.test(attribute)) {
    return null
  }
  return root.action || null
}

export function createBrowserPasswordFormScanner(
  valueOf: (input: HTMLInputElement) => string
): BrowserPasswordFormScanner {
  const everPassword = new WeakSet<HTMLInputElement>()
  const shadowRoots = new Set<ShadowRoot>()
  const formSignatures = createBrowserPasswordElementTokens<BrowserPasswordFormRoot>()

  const notePasswordInputs = (inputs: Iterable<HTMLInputElement>): void => {
    for (const input of inputs) {
      if (input.type === 'password') {
        everPassword.add(input)
      }
    }
  }

  const discoverShadowRoots = (node: Node): ShadowRoot[] => {
    const found: ShadowRoot[] = []
    const visit = (root: Node): void => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
      for (let current: Node | null = walker.currentNode; current; current = walker.nextNode()) {
        const shadow = current instanceof Element ? current.shadowRoot : null
        if (shadow && !shadowRoots.has(shadow)) {
          shadowRoots.add(shadow)
          found.push(shadow)
          visit(shadow)
        }
      }
    }
    visit(node)
    return found
  }

  const collectInputs = (): HTMLInputElement[] => {
    for (const root of shadowRoots) {
      if (!root.host.isConnected) {
        shadowRoots.delete(root)
      }
    }
    if (shadowRoots.size === 0) {
      return Array.from(document.querySelectorAll('input'))
    }
    // Why a full walk only with shadow roots: it is the only way to keep composed document order.
    const inputs: HTMLInputElement[] = []
    const visit = (root: Document | ShadowRoot): void => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (current instanceof HTMLInputElement) {
          inputs.push(current)
        }
        const shadow = current instanceof Element ? current.shadowRoot : null
        if (shadow) {
          shadowRoots.add(shadow)
          visit(shadow)
        }
      }
    }
    visit(document)
    return inputs
  }

  const describe = (input: HTMLInputElement): DomPasswordField | null => {
    const type = input.type.toLowerCase()
    if (type === 'password') {
      everPassword.add(input)
    }
    const wasPassword = everPassword.has(input)
    if (!isCredentialInputType(type, wasPassword) || input.disabled) {
      return null
    }
    return {
      element: input,
      type,
      wasPassword,
      name: input.name,
      id: input.id,
      autocomplete: input.getAttribute('autocomplete') ?? '',
      placeholder: input.placeholder,
      ariaLabel: input.getAttribute('aria-label') ?? '',
      labelText: labelTextOf(input),
      value: valueOf(input),
      visible: isRenderedElement(input),
      disabled: input.disabled
    }
  }

  const parseGroup = (
    root: BrowserPasswordFormRoot,
    inputs: readonly HTMLInputElement[]
  ): ScannedPasswordForm | null => {
    const fields = inputs.map(describe).filter((field): field is DomPasswordField => field !== null)
    if (fields.length === 0) {
      return null
    }
    const parsed = parsePasswordForm({ fields, text: formTextOf(root) })
    return parsed ? { root, signature: formSignatures.tokenFor(root), parsed } : null
  }

  const groupInputs = (): Map<BrowserPasswordFormRoot, HTMLInputElement[]> => {
    const groups = new Map<BrowserPasswordFormRoot, HTMLInputElement[]>()
    for (const input of collectInputs()) {
      const root = formRootOf(input)
      const group = groups.get(root)
      if (group) {
        group.push(input)
      } else {
        groups.set(root, [input])
      }
    }
    return groups
  }

  return {
    notePasswordInputs,
    noteTypeChange(input, oldType) {
      if (oldType?.toLowerCase() === 'password' || input.type === 'password') {
        everPassword.add(input)
      }
    },
    discoverShadowRoots,
    hasAnyInput: () => shadowRoots.size > 0 || document.querySelector('input') !== null,
    scan() {
      const forms: ScannedPasswordForm[] = []
      for (const [root, inputs] of groupInputs()) {
        const form = parseGroup(root, inputs)
        if (form) {
          forms.push(form)
        }
      }
      return forms
    },
    scanFormOf(input) {
      const root = formRootOf(input)
      return parseGroup(root, groupInputs().get(root) ?? [])
    },
    summaryOf(form) {
      const { parsed } = form
      return {
        formSignature: form.signature,
        kind: parsed.kind,
        usernameFieldName: fieldNameOf(parsed.username),
        passwordFieldName: fieldNameOf(parsed.password ?? parsed.newPassword),
        action: actionOf(form.root)
      }
    }
  }
}
