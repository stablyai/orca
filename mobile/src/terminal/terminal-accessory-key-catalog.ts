import { mobileI18n, t } from '@/i18n/mobile-i18n'
import type { TerminalAccessoryKey } from './terminal-accessory-keys'

const canonicalTerminalLabel = mobileI18n.getFixedT('en')

export const TERMINAL_ACCESSORY_KEYS: TerminalAccessoryKey[] = [
  {
    id: 'escape',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.esc'),
    bytes: '\x1b',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.escape')
  },
  {
    id: 'tab',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.tab'),
    bytes: '\t',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.tab')
  },
  {
    id: 'enter',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.enter'),
    bytes: '\r',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.enter')
  },
  // Why: terminal apps recognize ESC [ Z as the reverse-tab sequence.
  {
    id: 'shiftTab',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.shiftPlus'),
    bytes: '\x1b[Z',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.shiftTab')
  },
  {
    id: 'space',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.space'),
    bytes: ' ',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.space')
  },
  {
    id: 'backspace',
    label: '⌫',
    bytes: '\x7f',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.backspace'),
    repeatable: true
  },
  {
    id: 'delete',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.del'),
    bytes: '\x1b[3~',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.forward'),
    repeatable: true
  },
  {
    id: 'arrowUp',
    label: '↑',
    bytes: '\x1b[A',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.arrowUp'),
    repeatable: true
  },
  {
    id: 'arrowDown',
    label: '↓',
    bytes: '\x1b[B',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.arrowDown'),
    repeatable: true
  },
  {
    id: 'arrowLeft',
    label: '←',
    bytes: '\x1b[D',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.arrowLeft'),
    repeatable: true
  },
  {
    id: 'arrowRight',
    label: '→',
    bytes: '\x1b[C',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.arrowRight'),
    repeatable: true
  },
  {
    id: 'ctrlC',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlusC'),
    bytes: '\x03',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.interrupt')
  },
  {
    id: 'ctrlD',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlusD'),
    bytes: '\x04',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.send')
  },
  {
    id: 'ctrlL',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlusL'),
    bytes: '\x0c',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.clearScreen')
  },
  {
    id: 'ctrlZ',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlusZ'),
    bytes: '\x1a',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.suspend')
  },
  {
    id: 'ctrlR',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlusR'),
    bytes: '\x12',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.reverse')
  },
  {
    id: 'ctrlA',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlus'),
    bytes: '\x01',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.start')
  },
  {
    id: 'ctrlE',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlusE'),
    bytes: '\x05',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.end')
  },
  {
    id: 'ctrlW',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlusW'),
    bytes: '\x17',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.delete')
  },
  {
    id: 'ctrlU',
    label: canonicalTerminalLabel('terminalAccessoryKeyCatalog.ctrlPlusU'),
    bytes: '\x15',
    accessibilityLabel: t('terminalAccessoryKeyCatalog.clearLine')
  }
]
