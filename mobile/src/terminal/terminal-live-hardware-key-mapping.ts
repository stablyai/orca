import { buildTerminalShortcutKey, type TerminalShortcutModifier } from './terminal-accessory-keys'
import { getTerminalLiveSpecialKeyDecision } from './terminal-live-text-commit'

export type TerminalLiveHardwareKeyModifiers = {
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
}

export type TerminalLiveHardwareKeyEvent = {
  readonly key: string
  readonly modifiers: TerminalLiveHardwareKeyModifiers
  readonly repeat: boolean
}

export type TerminalLiveHardwareKeyDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'local-edit'; readonly localEdit: 'backspace' | 'delete' }
  | { readonly kind: 'send-bytes'; readonly bytes: string }
  | { readonly kind: 'flush-field-then-send'; readonly bytes: string }

const SPECIAL_DOM_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Escape',
  'Esc',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12'
])

function isInputMethodSwitcherShortcut(event: TerminalLiveHardwareKeyEvent): boolean {
  return (
    event.modifiers.ctrl && (event.key === ' ' || event.key === 'Space' || event.key === 'Spacebar')
  )
}

// Meta, Enter, and Ctrl+Space stay system/TextInput-owned; printable Option input
// must continue through TextInput so accented characters and IMEs keep working.
export function mapTerminalLiveHardwareKeyEvent(
  event: TerminalLiveHardwareKeyEvent,
  options: {
    readonly heldText: string
    readonly sentText: string
  }
): TerminalLiveHardwareKeyDecision {
  if (event.modifiers.meta) {
    return { kind: 'ignore' }
  }

  if (event.key === 'Enter') {
    return { kind: 'ignore' }
  }

  if (isInputMethodSwitcherShortcut(event)) {
    return { kind: 'ignore' }
  }

  const key = event.key
  const isSpecial = SPECIAL_DOM_KEYS.has(key)
  const isSingleChar = key.length === 1
  const hasTerminalModifier = event.modifiers.ctrl || event.modifiers.alt || event.modifiers.shift

  if (!isSpecial && isSingleChar && !event.modifiers.ctrl) {
    return { kind: 'ignore' }
  }

  if (isSpecial && !hasTerminalModifier && (key === 'Backspace' || key === 'Delete')) {
    const decision = getTerminalLiveSpecialKeyDecision({
      key,
      heldText: options.heldText,
      sentText: options.sentText
    })
    if (decision.kind === 'local-edit') {
      return {
        kind: 'local-edit',
        localEdit: key === 'Backspace' ? 'backspace' : 'delete'
      }
    }
    if (decision.kind === 'send-now') {
      return getHardwareControlSendDecision(decision.bytes, options)
    }
    if (decision.kind === 'commit-held-then-send') {
      return { kind: 'flush-field-then-send', bytes: decision.bytes }
    }
    return { kind: 'ignore' }
  }

  if (isSpecial && !hasTerminalModifier) {
    const decision = getTerminalLiveSpecialKeyDecision({
      key,
      heldText: options.heldText,
      sentText: options.sentText
    })
    if (decision.kind === 'send-now') {
      return getHardwareControlSendDecision(decision.bytes, options)
    }
    if (decision.kind === 'commit-held-then-send') {
      return { kind: 'flush-field-then-send', bytes: decision.bytes }
    }
    return { kind: 'ignore' }
  }

  // Ctrl/Alt modified special or printable → accessory key builder.
  const shortcutKey = toShortcutKeyId(key)
  if (!shortcutKey) {
    return { kind: 'ignore' }
  }
  const modifiers = toShortcutModifiers(event.modifiers)
  const built = buildTerminalShortcutKey({ key: shortcutKey, modifiers })
  if (!built) {
    return { kind: 'ignore' }
  }
  return getHardwareControlSendDecision(built.bytes, options)
}

// Why: terminal navigation/control invalidates the hidden field's editing
// baseline; end that mirror session before later printable input resumes.
function getHardwareControlSendDecision(
  bytes: string,
  options: { readonly heldText: string; readonly sentText: string }
): TerminalLiveHardwareKeyDecision {
  return options.heldText.length > 0 || options.sentText.length > 0
    ? { kind: 'flush-field-then-send', bytes }
    : { kind: 'send-bytes', bytes }
}

function toShortcutModifiers(
  modifiers: TerminalLiveHardwareKeyModifiers
): TerminalShortcutModifier[] {
  const result: TerminalShortcutModifier[] = []
  if (modifiers.ctrl) {
    result.push('ctrl')
  }
  if (modifiers.alt) {
    result.push('alt')
  }
  if (modifiers.shift) {
    result.push('shift')
  }
  return result
}

function toShortcutKeyId(key: string): string | null {
  switch (key) {
    case 'ArrowUp':
      return 'arrowUp'
    case 'ArrowDown':
      return 'arrowDown'
    case 'ArrowLeft':
      return 'arrowLeft'
    case 'ArrowRight':
      return 'arrowRight'
    case 'Escape':
    case 'Esc':
      return 'escape'
    case 'Tab':
      return 'tab'
    case 'Backspace':
      return 'backspace'
    case 'Delete':
      return 'delete'
    case 'Home':
      return 'home'
    case 'End':
      return 'end'
    case 'PageUp':
      return 'pageUp'
    case 'PageDown':
      return 'pageDown'
    case 'Enter':
      return 'enter'
    case 'F1':
    case 'F2':
    case 'F3':
    case 'F4':
    case 'F5':
    case 'F6':
    case 'F7':
    case 'F8':
    case 'F9':
    case 'F10':
    case 'F11':
    case 'F12':
      return key.toLowerCase()
    default:
      if (key.length === 1) {
        return key
      }
      return null
  }
}
