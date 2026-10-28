/**
 * Manifest `commands` (Chromium commands.json): each command's shortcut for this platform, in
 * Chrome's string form, and matching against a key event.
 */

export type BrowserExtensionCommand = {
  name: string
  description: string
  /** Chrome's form, e.g. "Ctrl+Shift+Y"; on macOS "⇧⌘Y". Empty when none is assigned. */
  shortcut: string
  binding: ParsedShortcut | null
}

export type ParsedShortcut = {
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

type KeyInput = Pick<Electron.Input, 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift'>

export const EXECUTE_ACTION_COMMANDS = new Set([
  '_execute_action',
  '_execute_browser_action',
  '_execute_page_action'
])

const PLATFORM_KEYS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'mac',
  win32: 'windows',
  linux: 'linux'
}

// Chrome assigns suggested keys to at most four commands.
const MAX_SUGGESTED_SHORTCUTS = 4

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** "Ctrl+Shift+Y" → modifiers + key. On macOS Chrome reads Ctrl as Command and MacCtrl as Control. */
export function parseExtensionShortcut(
  shortcut: string,
  platform: NodeJS.Platform
): ParsedShortcut | null {
  const parts = shortcut.split('+').map((part) => part.trim())
  const key = parts.pop()
  if (!key || parts.length === 0) {
    return null
  }
  const parsed: ParsedShortcut = { key, control: false, meta: false, alt: false, shift: false }
  for (const modifier of parts) {
    if (modifier === 'Ctrl') {
      parsed[platform === 'darwin' ? 'meta' : 'control'] = true
    } else if (modifier === 'Command') {
      parsed.meta = true
    } else if (modifier === 'MacCtrl') {
      parsed.control = true
    } else if (modifier === 'Alt') {
      parsed.alt = true
    } else if (modifier === 'Shift') {
      parsed.shift = true
    } else {
      return null
    }
  }
  // Chrome requires Ctrl/Command/Alt (MacCtrl on mac); Shift alone is not a command.
  return parsed.control || parsed.meta || parsed.alt ? parsed : null
}

const MAC_SYMBOLS: [keyof ParsedShortcut, string][] = [
  ['control', '⌃'],
  ['alt', '⌥'],
  ['shift', '⇧'],
  ['meta', '⌘']
]

function formatShortcut(parsed: ParsedShortcut, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return `${MAC_SYMBOLS.filter(([flag]) => parsed[flag])
      .map(([, symbol]) => symbol)
      .join('')}${parsed.key}`
  }
  return [
    parsed.control ? 'Ctrl' : '',
    parsed.alt ? 'Alt' : '',
    parsed.shift ? 'Shift' : '',
    parsed.key
  ]
    .filter(Boolean)
    .join('+')
}

export function readBrowserExtensionCommands(
  manifest: Record<string, unknown> | undefined,
  platform: NodeJS.Platform
): BrowserExtensionCommand[] {
  const commands = asRecord(manifest?.commands) ?? {}
  let assigned = 0
  return Object.entries(commands).map(([name, raw]) => {
    const command = asRecord(raw) ?? {}
    const suggested = asRecord(command.suggested_key)
    const wanted = suggested?.[PLATFORM_KEYS[platform] ?? ''] ?? suggested?.default
    const binding =
      typeof wanted === 'string' && assigned < MAX_SUGGESTED_SHORTCUTS
        ? parseExtensionShortcut(wanted, platform)
        : null
    if (binding) {
      assigned++
    }
    return {
      name,
      description: typeof command.description === 'string' ? command.description : '',
      shortcut: binding ? formatShortcut(binding, platform) : '',
      binding
    }
  })
}

const KEY_ALIASES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Space: ' ',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight'
}

export function shortcutMatchesInput(binding: ParsedShortcut, input: KeyInput): boolean {
  if (
    binding.control !== input.control ||
    binding.meta !== input.meta ||
    binding.alt !== input.alt ||
    binding.shift !== input.shift
  ) {
    return false
  }
  const wanted = KEY_ALIASES[binding.key] ?? binding.key
  if (/^[A-Z0-9]$/.test(wanted)) {
    // Why code: Alt/Option and Shift change `key` (e.g. "Ÿ"), the physical key does not.
    return input.code === (/\d/.test(wanted) ? `Digit${wanted}` : `Key${wanted}`)
  }
  return input.key === wanted
}
