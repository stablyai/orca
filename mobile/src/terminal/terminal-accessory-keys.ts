export type TerminalAccessoryKey = {
  label: string
  bytes: string
  accessibilityLabel?: string
  repeatable?: boolean
}

export const TERMINAL_ACCESSORY_KEYS: TerminalAccessoryKey[] = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  // Why: terminal apps recognize ESC [ Z as the reverse-tab sequence.
  { label: 'Shift+Tab', bytes: '\x1b[Z', accessibilityLabel: 'Shift Tab' },
  { label: '⌫', bytes: '\x7f', accessibilityLabel: 'Backspace', repeatable: true },
  { label: 'Del', bytes: '\x1b[3~', accessibilityLabel: 'Forward delete', repeatable: true },
  { label: '↑', bytes: '\x1b[A', repeatable: true },
  { label: '↓', bytes: '\x1b[B', repeatable: true },
  { label: '←', bytes: '\x1b[D', repeatable: true },
  { label: '→', bytes: '\x1b[C', repeatable: true },
  { label: 'Ctrl+C', bytes: '\x03', accessibilityLabel: 'Interrupt terminal' },
  { label: 'Ctrl+D', bytes: '\x04', accessibilityLabel: 'Send EOF' },
  { label: 'Ctrl+L', bytes: '\x0c', accessibilityLabel: 'Clear screen' },
  { label: 'Ctrl+Z', bytes: '\x1a', accessibilityLabel: 'Suspend process' },
  { label: 'Ctrl+R', bytes: '\x12', accessibilityLabel: 'Reverse search' },
  { label: 'Ctrl+A', bytes: '\x01', accessibilityLabel: 'Start of line' },
  { label: 'Ctrl+E', bytes: '\x05', accessibilityLabel: 'End of line' },
  { label: 'Ctrl+W', bytes: '\x17', accessibilityLabel: 'Delete word backward' },
  { label: 'Ctrl+U', bytes: '\x15', accessibilityLabel: 'Clear line before cursor' }
]
