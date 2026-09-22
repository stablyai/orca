import {
  SPECIAL_KEY_LABELS,
  TERMINAL_ACCESSORY_KEY_DEFINITIONS,
  TERMINAL_SHORTCUT_SPECIAL_KEY_DEFINITIONS
} from './terminal-key-definitions'

export type TerminalAccessoryKey = {
  id: string
  label: string
  bytes: string
  accessibilityLabel?: string
  repeatable?: boolean
}

export type TerminalShortcutModifier = 'ctrl' | 'alt' | 'shift'

export type TerminalShortcutBinding = {
  key: string
  modifiers: TerminalShortcutModifier[]
}

export type TerminalShortcutBuildResult = {
  label: string
  bytes: string
  accessibilityLabel: string
}

export type TerminalShortcutSpecialKey = {
  id: string
  label: string
  accessibilityLabel: string
}

const ESC = '\x1b'

const MODIFIER_LABELS: Record<TerminalShortcutModifier, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift'
}

const MODIFIER_ORDER: TerminalShortcutModifier[] = ['ctrl', 'alt', 'shift']

const SHIFTED_PRINTABLE: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?'
}

const CTRL_PRINTABLE_BYTES: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '`': '\x00',
  '[': '\x1b',
  '{': '\x1b',
  '\\': '\x1c',
  '|': '\x1c',
  ']': '\x1d',
  '}': '\x1d',
  '^': '\x1e',
  '~': '\x1e',
  _: '\x1f',
  '?': '\x7f'
}

const CSI_FINAL_SPECIAL_KEYS: Record<string, string> = {
  arrowUp: 'A',
  arrowDown: 'B',
  arrowRight: 'C',
  arrowLeft: 'D',
  home: 'H',
  end: 'F',
  f1: 'P',
  f2: 'Q',
  f3: 'R',
  f4: 'S'
}

const SS3_BASE_SPECIAL_KEYS = new Set(['f1', 'f2', 'f3', 'f4'])

const CSI_TILDE_SPECIAL_KEYS: Record<string, number> = {
  insert: 2,
  delete: 3,
  pageUp: 5,
  pageDown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24
}

export const TERMINAL_SHORTCUT_SPECIAL_KEYS = TERMINAL_SHORTCUT_SPECIAL_KEY_DEFINITIONS

export const TERMINAL_ACCESSORY_KEYS = TERMINAL_ACCESSORY_KEY_DEFINITIONS

export function buildTerminalShortcutKey(
  binding: TerminalShortcutBinding
): TerminalShortcutBuildResult | null {
  const key = normalizeShortcutKey(binding.key)
  if (!key) {
    return null
  }
  const modifiers = normalizeModifiers(binding.modifiers)
  const bytes = buildShortcutBytes(key, modifiers)
  if (bytes == null) {
    return null
  }
  const label = formatShortcutLabel(key, modifiers)
  return {
    label,
    bytes,
    accessibilityLabel: label.replaceAll('+', ' ')
  }
}

export function normalizeShortcutKeyInput(value: string): string | null {
  const chars = Array.from(value)
  const firstVisible = chars.find((char) => char !== '\n' && char !== '\r' && char !== '\t')
  if (!firstVisible) {
    return null
  }
  return normalizeShortcutKey(firstVisible)
}

function buildShortcutBytes(key: string, modifiers: TerminalShortcutModifier[]): string | null {
  if (key === 'space') {
    return buildPrintableShortcutBytes(' ', modifiers)
  }
  const csiFinal = CSI_FINAL_SPECIAL_KEYS[key]
  if (csiFinal) {
    // Why: xterm encodes unmodified F1-F4 as SS3 (ESC O P/S). Once a
    // modifier is present it switches to the CSI 1;N form like arrows.
    if (SS3_BASE_SPECIAL_KEYS.has(key) && csiModifierParameter(modifiers) === 1) {
      return `${ESC}O${csiFinal}`
    }
    return buildCsiFinalShortcut(csiFinal, modifiers)
  }
  const csiTilde = CSI_TILDE_SPECIAL_KEYS[key]
  if (csiTilde) {
    return buildCsiTildeShortcut(csiTilde, modifiers)
  }
  if (key === 'tab') {
    if (modifiers.includes('shift') && !modifiers.includes('ctrl') && !modifiers.includes('alt')) {
      return `${ESC}[Z`
    }
    const bytes = '\t'
    return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
  }
  if (key === 'escape') {
    const bytes = ESC
    return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
  }
  if (key === 'enter') {
    const bytes = '\r'
    return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
  }
  if (key === 'backspace') {
    const bytes = modifiers.includes('ctrl') ? '\b' : '\x7f'
    return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
  }
  if (isPrintableShortcutKey(key)) {
    return buildPrintableShortcutBytes(key, modifiers)
  }
  return null
}

function buildPrintableShortcutBytes(
  key: string,
  modifiers: TerminalShortcutModifier[]
): string | null {
  const shifted = modifiers.includes('shift') ? applyShift(key) : key
  let bytes = shifted
  if (modifiers.includes('ctrl')) {
    const ctrlBytes = controlBytesForPrintable(shifted)
    if (ctrlBytes == null) {
      return null
    }
    bytes = ctrlBytes
  }
  return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
}

function buildCsiFinalShortcut(final: string, modifiers: TerminalShortcutModifier[]): string {
  const parameter = csiModifierParameter(modifiers)
  return parameter === 1 ? `${ESC}[${final}` : `${ESC}[1;${parameter}${final}`
}

function buildCsiTildeShortcut(code: number, modifiers: TerminalShortcutModifier[]): string {
  const parameter = csiModifierParameter(modifiers)
  return parameter === 1 ? `${ESC}[${code}~` : `${ESC}[${code};${parameter}~`
}

function csiModifierParameter(modifiers: TerminalShortcutModifier[]): number {
  let parameter = 1
  if (modifiers.includes('shift')) {
    parameter += 1
  }
  if (modifiers.includes('alt')) {
    parameter += 2
  }
  if (modifiers.includes('ctrl')) {
    parameter += 4
  }
  return parameter
}

function controlBytesForPrintable(key: string): string | null {
  const lower = key.toLowerCase()
  if (lower >= 'a' && lower <= 'z') {
    return String.fromCharCode(lower.charCodeAt(0) - 96)
  }
  return CTRL_PRINTABLE_BYTES[key] ?? null
}

function applyShift(key: string): string {
  if (key >= 'a' && key <= 'z') {
    return key.toUpperCase()
  }
  if (key >= 'A' && key <= 'Z') {
    return key
  }
  return SHIFTED_PRINTABLE[key] ?? key
}

function normalizeModifiers(modifiers: TerminalShortcutModifier[]): TerminalShortcutModifier[] {
  const selected = new Set(modifiers)
  return MODIFIER_ORDER.filter((modifier) => selected.has(modifier))
}

function normalizeShortcutKey(key: string): string | null {
  if (SPECIAL_KEY_LABELS[key]) {
    return key
  }
  if (key.length === 1 && isPrintableShortcutKey(key)) {
    return key >= 'A' && key <= 'Z' ? key.toLowerCase() : key
  }
  return null
}

function isPrintableShortcutKey(key: string): boolean {
  return key.length === 1 && key >= ' ' && key <= '~'
}

function formatShortcutLabel(key: string, modifiers: TerminalShortcutModifier[]): string {
  const modifierLabels = modifiers.map((modifier) => MODIFIER_LABELS[modifier])
  return [...modifierLabels, displayKeyLabel(key)].join('+')
}

function displayKeyLabel(key: string): string {
  if (SPECIAL_KEY_LABELS[key]) {
    return SPECIAL_KEY_LABELS[key]
  }
  if (key === ' ') {
    return 'Space'
  }
  return key.length === 1 && key >= 'a' && key <= 'z' ? key.toUpperCase() : key
}
