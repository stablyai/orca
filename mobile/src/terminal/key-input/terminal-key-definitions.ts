import type { Translate } from '../../i18n/mobile-i18n'
import type { TerminalAccessoryKey, TerminalShortcutSpecialKey } from './terminal-accessory-keys'

export const SPECIAL_KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  tab: 'Tab',
  enter: 'Enter',
  backspace: '⌫',
  delete: 'Del',
  insert: 'Ins',
  arrowUp: '↑',
  arrowDown: '↓',
  arrowLeft: '←',
  arrowRight: '→',
  home: 'Home',
  end: 'End',
  pageUp: 'PgUp',
  pageDown: 'PgDn',
  space: 'Space',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12'
}

const SPECIAL_KEY_ACCESSIBILITY_LABELS: Record<string, string> = {
  escape: 'Escape',
  tab: 'Tab',
  enter: 'Enter',
  backspace: 'Backspace',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageUp: 'Page up',
  pageDown: 'Page down',
  space: 'Space',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12'
}

const forwardDeleteLabel = (t: Translate) =>
  t('terminal.keyDefinitions.forwardDelete', 'Forward delete')

const TRANSLATED_SPECIAL_KEY_ACCESSIBILITY_LABELS: Record<string, (t: Translate) => string> = {
  delete: forwardDeleteLabel,
  arrowUp: (t) => t('terminal.keyDefinitions.arrowUp', 'Arrow up'),
  arrowDown: (t) => t('terminal.keyDefinitions.arrowDown', 'Arrow down'),
  arrowLeft: (t) => t('terminal.keyDefinitions.arrowLeft', 'Arrow left'),
  arrowRight: (t) => t('terminal.keyDefinitions.arrowRight', 'Arrow right')
}

export function terminalSpecialKeyAccessibilityLabel(id: string, t: Translate): string {
  return (
    TRANSLATED_SPECIAL_KEY_ACCESSIBILITY_LABELS[id]?.(t) ??
    SPECIAL_KEY_ACCESSIBILITY_LABELS[id] ??
    id
  )
}

const TRANSLATED_ACCESSORY_KEY_ACCESSIBILITY_LABELS: Record<string, (t: Translate) => string> = {
  delete: forwardDeleteLabel,
  arrowUp: (t) => t('terminal.keyDefinitions.accessoryArrowUp', 'Arrow Up'),
  arrowDown: (t) => t('terminal.keyDefinitions.accessoryArrowDown', 'Arrow Down'),
  arrowLeft: (t) => t('terminal.keyDefinitions.accessoryArrowLeft', 'Arrow Left'),
  arrowRight: (t) => t('terminal.keyDefinitions.accessoryArrowRight', 'Arrow Right'),
  ctrlC: (t) => t('terminal.keyDefinitions.interruptTerminal', 'Interrupt terminal'),
  ctrlD: (t) => t('terminal.keyDefinitions.sendEof', 'Send EOF'),
  ctrlL: (t) => t('terminal.keyDefinitions.clearScreen', 'Clear screen'),
  ctrlZ: (t) => t('terminal.keyDefinitions.suspendProcess', 'Suspend process'),
  ctrlR: (t) => t('terminal.keyDefinitions.reverseSearch', 'Reverse search'),
  ctrlA: (t) => t('terminal.keyDefinitions.startOfLine', 'Start of line'),
  ctrlE: (t) => t('terminal.keyDefinitions.endOfLine', 'End of line'),
  ctrlW: (t) => t('terminal.keyDefinitions.deleteWordBackward', 'Delete word backward'),
  ctrlU: (t) => t('terminal.keyDefinitions.clearLineBeforeCursor', 'Clear line before cursor')
}

export function terminalAccessoryKeyAccessibilityLabel(
  key: TerminalAccessoryKey,
  t: Translate
): string | undefined {
  return TRANSLATED_ACCESSORY_KEY_ACCESSIBILITY_LABELS[key.id]?.(t) ?? key.accessibilityLabel
}

export const TERMINAL_SHORTCUT_SPECIAL_KEY_DEFINITIONS: TerminalShortcutSpecialKey[] = [
  'escape',
  'tab',
  'enter',
  'backspace',
  'delete',
  'insert',
  'arrowUp',
  'arrowDown',
  'arrowLeft',
  'arrowRight',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'space',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12'
].map((id) => ({
  id,
  label: SPECIAL_KEY_LABELS[id]!
}))

export const TERMINAL_ACCESSORY_KEY_DEFINITIONS: TerminalAccessoryKey[] = [
  { id: 'escape', label: 'Esc', bytes: '\x1b', accessibilityLabel: 'Escape' },
  { id: 'tab', label: 'Tab', bytes: '\t', accessibilityLabel: 'Tab' },
  { id: 'enter', label: 'Enter', bytes: '\r', accessibilityLabel: 'Enter' },
  { id: 'shiftTab', label: '⇧Tab', bytes: '\x1b[Z', accessibilityLabel: 'Shift Tab' },
  { id: 'space', label: 'Space', bytes: ' ', accessibilityLabel: 'Space' },
  { id: 'backspace', label: '⌫', bytes: '\x7f', accessibilityLabel: 'Backspace', repeatable: true },
  {
    id: 'delete',
    label: 'Del',
    bytes: '\x1b[3~',
    repeatable: true
  },
  {
    id: 'arrowUp',
    label: '↑',
    bytes: '\x1b[A',
    repeatable: true
  },
  {
    id: 'arrowDown',
    label: '↓',
    bytes: '\x1b[B',
    repeatable: true
  },
  {
    id: 'arrowLeft',
    label: '←',
    bytes: '\x1b[D',
    repeatable: true
  },
  {
    id: 'arrowRight',
    label: '→',
    bytes: '\x1b[C',
    repeatable: true
  },
  {
    id: 'ctrlC',
    label: 'Ctrl+C',
    bytes: '\x03'
  },
  {
    id: 'ctrlD',
    label: 'Ctrl+D',
    bytes: '\x04'
  },
  {
    id: 'ctrlL',
    label: 'Ctrl+L',
    bytes: '\x0c'
  },
  {
    id: 'ctrlZ',
    label: 'Ctrl+Z',
    bytes: '\x1a'
  },
  {
    id: 'ctrlR',
    label: 'Ctrl+R',
    bytes: '\x12'
  },
  {
    id: 'ctrlA',
    label: 'Ctrl+A',
    bytes: '\x01'
  },
  {
    id: 'ctrlE',
    label: 'Ctrl+E',
    bytes: '\x05'
  },
  {
    id: 'ctrlW',
    label: 'Ctrl+W',
    bytes: '\x17'
  },
  {
    id: 'ctrlU',
    label: 'Ctrl+U',
    bytes: '\x15'
  }
]
