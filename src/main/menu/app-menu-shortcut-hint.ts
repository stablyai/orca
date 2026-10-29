import { formatKeybindingList, parseKeybinding } from '../../shared/keybindings'

type ShortcutHintMenuItemFields = Pick<
  Electron.MenuItemConstructorOptions,
  'label' | 'accelerator' | 'registerAccelerator'
>

const ELECTRON_KEY_TOKENS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Underscore: '_',
  Equal: '=',
  Plus: 'Plus',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub'
}

function toNonMacMenuAccelerator(binding: string): string | null {
  const parsed = parseKeybinding(binding)
  if (!parsed || parsed.doubleTapModifier || !parsed.key) {
    return null
  }
  const parts: string[] = []
  if (parsed.mod || parsed.control) {
    parts.push('Ctrl')
  }
  if (parsed.meta) {
    parts.push('Super')
  }
  if (parsed.alt) {
    parts.push('Alt')
  }
  if (parsed.shift) {
    parts.push('Shift')
  }
  parts.push(ELECTRON_KEY_TOKENS[parsed.key] ?? parsed.key)
  return parts.join('+')
}

/** Display-only shortcut hint; the renderer, not a native accelerator, owns the key. */
export function appMenuShortcutHint(
  label: string,
  bindings: readonly string[],
  platform: NodeJS.Platform
): ShortcutHintMenuItemFields {
  if (platform === 'darwin') {
    return { label: `${label}\t${formatKeybindingList(bindings, platform)}` }
  }
  // Chromium's views menus draw a label tab as a literal arrow (#34491); show the first binding natively instead.
  const accelerator = bindings.map(toNonMacMenuAccelerator).find((value) => value !== null)
  return accelerator ? { label, accelerator, registerAccelerator: false } : { label }
}
