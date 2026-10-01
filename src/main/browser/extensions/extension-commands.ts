/** An extension command, from its manifest `commands`, that a key press triggers. */
export type BrowserExtensionCommand = { extensionId: string; name: string }

/** Commands that open the extension's toolbar popup instead of reaching its worker. */
export const BROWSER_EXTENSION_ACTION_COMMANDS = new Set([
  '_execute_action',
  '_execute_browser_action'
])

const SUGGESTED_KEY_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'mac',
  win32: 'windows',
  linux: 'linux'
}

// Manifest key names that are not a single character, mapped to Input.key.
const NAMED_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Space: ' ',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete'
}

export function findBrowserExtensionCommand(
  extensions: readonly Electron.Extension[],
  input: Electron.Input,
  platform: NodeJS.Platform
): BrowserExtensionCommand | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) {
    return null
  }
  for (const extension of extensions) {
    const commands: unknown = extension.manifest.commands
    if (typeof commands !== 'object' || commands === null) {
      continue
    }
    for (const [name, command] of Object.entries(commands)) {
      const shortcut = readSuggestedKey(command, platform)
      if (shortcut && matchesShortcut(shortcut, input, platform)) {
        return { extensionId: extension.id, name }
      }
    }
  }
  return null
}

function readSuggestedKey(command: unknown, platform: NodeJS.Platform): string | null {
  const suggested: unknown = Reflect.get(Object(command), 'suggested_key')
  if (typeof suggested === 'string') {
    return suggested
  }
  const byPlatform = Object(suggested)
  const key: unknown =
    Reflect.get(byPlatform, SUGGESTED_KEY_PLATFORMS[platform] ?? '') ??
    Reflect.get(byPlatform, 'default')
  return typeof key === 'string' ? key : null
}

function matchesShortcut(
  shortcut: string,
  input: Electron.Input,
  platform: NodeJS.Platform
): boolean {
  const parts = shortcut.split('+').map((part) => part.trim())
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts)
  const mac = platform === 'darwin'
  // Why: Chrome reads "Ctrl" as Command on macOS; "MacCtrl" is the real Control key there.
  const meta = mac && (modifiers.has('Command') || modifiers.has('Ctrl'))
  const control = mac ? modifiers.has('MacCtrl') : modifiers.has('Ctrl')
  if (
    input.meta !== meta ||
    input.control !== control ||
    input.alt !== modifiers.has('Alt') ||
    input.shift !== modifiers.has('Shift')
  ) {
    return false
  }
  // Why code for letters and digits: Shift and the keyboard layout change Input.key, not the code.
  if (/^[A-Z]$/.test(key)) {
    return input.code === `Key${key}`
  }
  if (/^[0-9]$/.test(key)) {
    return input.code === `Digit${key}`
  }
  return input.key === (NAMED_KEYS[key] ?? key)
}

const MAC_MODIFIER_SYMBOLS: [string, string][] = [
  ['MacCtrl', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['Command', '⌘'],
  ['Ctrl', '⌘']
]

/** chrome.commands.getAll: the manifest's commands with shortcuts written as Chrome shows them. */
export function listBrowserExtensionCommands(
  extension: Pick<Electron.Extension, 'manifest'>,
  platform: NodeJS.Platform
): { name: string; description: string; shortcut: string }[] {
  const commands: unknown = extension.manifest.commands
  if (typeof commands !== 'object' || commands === null) {
    return []
  }
  return Object.entries(commands).map(([name, command]) => {
    const shortcut = readSuggestedKey(command, platform) ?? ''
    const description: unknown = Reflect.get(Object(command), 'description')
    return {
      name,
      description: typeof description === 'string' ? description : '',
      shortcut: platform === 'darwin' ? macShortcutLabel(shortcut) : shortcut
    }
  })
}

function macShortcutLabel(shortcut: string): string {
  if (!shortcut) {
    return ''
  }
  const parts = shortcut.split('+').map((part) => part.trim())
  const key = parts.pop() ?? ''
  const symbols = MAC_MODIFIER_SYMBOLS.filter(([name]) => parts.includes(name)).map(
    ([, symbol]) => symbol
  )
  return [...new Set(symbols)].join('') + key
}
