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
  delete: 'Forward delete',
  insert: 'Insert',
  arrowUp: 'Arrow up',
  arrowDown: 'Arrow down',
  arrowLeft: 'Arrow left',
  arrowRight: 'Arrow right',
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
  label: SPECIAL_KEY_LABELS[id]!,
  accessibilityLabel: SPECIAL_KEY_ACCESSIBILITY_LABELS[id]!
}))

export const TERMINAL_ACCESSORY_KEY_DEFINITIONS: TerminalAccessoryKey[] = [
  { id: 'escape', label: 'Esc', bytes: '\x1b', accessibilityLabel: 'Escape' },
  { id: 'tab', label: 'Tab', bytes: '\t', accessibilityLabel: 'Tab' },
  { id: 'enter', label: 'Enter', bytes: '\r', accessibilityLabel: 'Enter' },
  // Why: terminal apps recognize ESC [ Z as the reverse-tab sequence.
  { id: 'shiftTab', label: 'Shift+Tab', bytes: '\x1b[Z', accessibilityLabel: 'Shift Tab' },
  { id: 'space', label: 'Space', bytes: ' ', accessibilityLabel: 'Space' },
  { id: 'backspace', label: '⌫', bytes: '\x7f', accessibilityLabel: 'Backspace', repeatable: true },
  {
    id: 'delete',
    label: 'Del',
    bytes: '\x1b[3~',
    accessibilityLabel: 'Forward delete',
    repeatable: true
  },
  { id: 'arrowUp', label: '↑', bytes: '\x1b[A', accessibilityLabel: 'Arrow Up', repeatable: true },
  {
    id: 'arrowDown',
    label: '↓',
    bytes: '\x1b[B',
    accessibilityLabel: 'Arrow Down',
    repeatable: true
  },
  {
    id: 'arrowLeft',
    label: '←',
    bytes: '\x1b[D',
    accessibilityLabel: 'Arrow Left',
    repeatable: true
  },
  {
    id: 'arrowRight',
    label: '→',
    bytes: '\x1b[C',
    accessibilityLabel: 'Arrow Right',
    repeatable: true
  },
  { id: 'ctrlC', label: 'Ctrl+C', bytes: '\x03', accessibilityLabel: 'Interrupt terminal' },
  { id: 'ctrlD', label: 'Ctrl+D', bytes: '\x04', accessibilityLabel: 'Send EOF' },
  { id: 'ctrlL', label: 'Ctrl+L', bytes: '\x0c', accessibilityLabel: 'Clear screen' },
  { id: 'ctrlZ', label: 'Ctrl+Z', bytes: '\x1a', accessibilityLabel: 'Suspend process' },
  { id: 'ctrlR', label: 'Ctrl+R', bytes: '\x12', accessibilityLabel: 'Reverse search' },
  { id: 'ctrlA', label: 'Ctrl+A', bytes: '\x01', accessibilityLabel: 'Start of line' },
  { id: 'ctrlE', label: 'Ctrl+E', bytes: '\x05', accessibilityLabel: 'End of line' },
  { id: 'ctrlW', label: 'Ctrl+W', bytes: '\x17', accessibilityLabel: 'Delete word backward' },
  { id: 'ctrlU', label: 'Ctrl+U', bytes: '\x15', accessibilityLabel: 'Clear line before cursor' }
]
