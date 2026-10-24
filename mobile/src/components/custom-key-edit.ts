import {
  buildTerminalShortcutKey,
  normalizeShortcutKeyInput,
  type TerminalShortcutModifier
} from '../terminal/terminal-accessory-keys'
import { SPECIAL_KEY_LABELS } from '../terminal/terminal-key-definitions'

export type CustomKeyFields = {
  id: string
  label: string
  bytes: string
  enter: boolean
}

export type CustomKeyEditDraft = {
  step: 'choose-type' | 'shortcut-combo' | 'text-macro'
  shortcutKey: string
  shortcutModifiers: TerminalShortcutModifier[]
  macroLabel: string
  macroText: string
  macroEnter: boolean
}

type ShortcutBinding = {
  key: string
  modifiers: TerminalShortcutModifier[]
}

const MODIFIER_ORDER: TerminalShortcutModifier[] = ['ctrl', 'alt', 'shift']

const MODIFIER_COMBOS: TerminalShortcutModifier[][] = [
  [],
  ['ctrl'],
  ['alt'],
  ['shift'],
  ['ctrl', 'alt'],
  ['ctrl', 'shift'],
  ['alt', 'shift'],
  ['ctrl', 'alt', 'shift']
]

const MODIFIER_FROM_LABEL: Record<string, TerminalShortcutModifier> = {
  Ctrl: 'ctrl',
  Alt: 'alt',
  Shift: 'shift'
}

const SPECIAL_KEY_FROM_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(SPECIAL_KEY_LABELS).map(([id, label]) => [label, id])
)

const BRUTE_KEYS = bruteForceShortcutKeys()

const NEW_KEY_DRAFT: CustomKeyEditDraft = {
  step: 'choose-type',
  shortcutKey: 'c',
  shortcutModifiers: ['ctrl'],
  macroLabel: '',
  macroText: '',
  macroEnter: true
}

// Why: chords and text macros share one stored shape. Trust a label only when it
// rebuilds the same bytes; printable text (optional trailing CR) stays a macro.
export function customKeyEditDraft(editingKey: CustomKeyFields | null): CustomKeyEditDraft {
  if (!editingKey) {
    return {
      ...NEW_KEY_DRAFT,
      shortcutModifiers: [...NEW_KEY_DRAFT.shortcutModifiers]
    }
  }
  const binding = resolveShortcutBinding(editingKey)
  if (!binding) {
    const endsWithEnter = editingKey.bytes.endsWith('\r')
    return {
      step: 'text-macro',
      shortcutKey: NEW_KEY_DRAFT.shortcutKey,
      shortcutModifiers: [...NEW_KEY_DRAFT.shortcutModifiers],
      macroLabel: editingKey.label,
      macroText: endsWithEnter ? editingKey.bytes.slice(0, -1) : editingKey.bytes,
      macroEnter: endsWithEnter || editingKey.enter
    }
  }
  return {
    step: 'shortcut-combo',
    shortcutKey: binding.key,
    shortcutModifiers: binding.modifiers,
    macroLabel: '',
    macroText: '',
    macroEnter: true
  }
}

export function customKeyModalTitle(
  step: 'choose-type' | 'shortcut-combo' | 'special-keys' | 'text-macro',
  editing: boolean
): string {
  if (editing) {
    return 'Edit Shortcut'
  }
  if (step === 'choose-type') {
    return 'Add Shortcut'
  }
  if (step === 'shortcut-combo') {
    return 'Shortcut Combo'
  }
  if (step === 'special-keys') {
    return 'Pick a key'
  }
  return 'Text Macro'
}

export function customKeySaveLabel(editing: boolean, kind: 'combo' | 'macro'): string {
  if (editing) {
    return 'Save Changes'
  }
  return kind === 'combo' ? 'Add' : 'Add Shortcut'
}

export function replaceCustomKeyPreservingId<T extends { id: string }>(
  existing: T[],
  next: T
): T[] {
  let found = false
  const updated = existing.map((item) => {
    if (item.id !== next.id) {
      return item
    }
    found = true
    return next
  })
  return found ? updated : [...existing, next]
}

function resolveShortcutBinding(key: CustomKeyFields): ShortcutBinding | null {
  const fromLabel = parseLabelBinding(key.label)
  if (
    fromLabel &&
    builtBytes(fromLabel) === key.bytes &&
    (fromLabel.modifiers.length > 0 || isSpecialKeyLabel(key.label))
  ) {
    return fromLabel
  }
  if (isTextMacroBytes(key.bytes)) {
    return null
  }
  const fromBytes = bindingFromBytes(key.bytes)
  if (fromBytes) {
    return fromBytes
  }
  if (fromLabel && (fromLabel.modifiers.length > 0 || isSpecialKeyLabel(key.label))) {
    return fromLabel
  }
  return null
}

function parseLabelBinding(label: string): ShortcutBinding | null {
  const parts = label.split('+')
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    return null
  }
  const keyLabel = parts[parts.length - 1] ?? ''
  const modifiers: TerminalShortcutModifier[] = []
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_FROM_LABEL[part]
    if (!modifier) {
      return null
    }
    if (!modifiers.includes(modifier)) {
      modifiers.push(modifier)
    }
  }
  const key = SPECIAL_KEY_FROM_LABEL[keyLabel] ?? keyIdFromPrintableLabel(keyLabel)
  if (!key) {
    return null
  }
  const ordered = orderModifiers(modifiers)
  if (!buildTerminalShortcutKey({ key, modifiers: ordered })) {
    return null
  }
  return { key, modifiers: ordered }
}

function keyIdFromPrintableLabel(label: string): string | null {
  if (label.length !== 1) {
    return null
  }
  return normalizeShortcutKeyInput(label)
}

function isSpecialKeyLabel(label: string): boolean {
  return Object.hasOwn(SPECIAL_KEY_FROM_LABEL, label)
}

function isTextMacroBytes(bytes: string): boolean {
  if (bytes.endsWith('\r')) {
    const body = bytes.slice(0, -1)
    return body.length > 0 && !hasControlChar(body)
  }
  return !hasControlChar(bytes)
}

function hasControlChar(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
}

function bindingFromBytes(bytes: string): ShortcutBinding | null {
  let best: { binding: ShortcutBinding; score: number } | null = null
  for (const key of BRUTE_KEYS) {
    const special = Object.hasOwn(SPECIAL_KEY_LABELS, key)
    for (const modifiers of MODIFIER_COMBOS) {
      const binding = { key, modifiers }
      if (builtBytes(binding) !== bytes) {
        continue
      }
      const score = modifiers.length * 2 + (special ? 0 : 1)
      if (!best || score < best.score) {
        best = { binding: { key, modifiers: [...modifiers] }, score }
      }
    }
  }
  return best?.binding ?? null
}

function builtBytes(binding: ShortcutBinding): string | null {
  return buildTerminalShortcutKey(binding)?.bytes ?? null
}

function orderModifiers(modifiers: TerminalShortcutModifier[]): TerminalShortcutModifier[] {
  const selected = new Set(modifiers)
  return MODIFIER_ORDER.filter((modifier) => selected.has(modifier))
}

function bruteForceShortcutKeys(): string[] {
  const keys = Object.keys(SPECIAL_KEY_LABELS)
  const seen = new Set(keys)
  for (let code = 32; code <= 126; code += 1) {
    const normalized = normalizeShortcutKeyInput(String.fromCharCode(code))
    if (!normalized || normalized === ' ' || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    keys.push(normalized)
  }
  return keys
}
