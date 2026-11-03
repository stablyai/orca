import { describe, expect, it } from 'vitest'
import { parseExtensionShortcut, readBrowserExtensionCommands } from './browser-extension-commands'

// Bitwarden's manifest commands.
const manifest = {
  commands: {
    _execute_action: {
      suggested_key: { default: 'Ctrl+Shift+Y', linux: 'Ctrl+Shift+U' },
      description: '__MSG_commandOpenPopup__'
    },
    autofill_login: { suggested_key: { default: 'Ctrl+Shift+L' }, description: 'Fill login' },
    autofill_card: { description: 'Fill card' },
    generate_password: { suggested_key: { default: 'Ctrl+Shift+9' } }
  }
}

describe('manifest commands', () => {
  it('uses the platform key, Command for Ctrl on macOS, and Chrome shortcut strings', () => {
    expect(
      readBrowserExtensionCommands(manifest, 'darwin').map((c) => [c.name, c.shortcut])
    ).toEqual([
      ['_execute_action', '⇧⌘Y'],
      ['autofill_login', '⇧⌘L'],
      ['autofill_card', ''],
      ['generate_password', '⇧⌘9']
    ])
    expect(readBrowserExtensionCommands(manifest, 'linux')[0].shortcut).toBe('Ctrl+Shift+U')
    expect(readBrowserExtensionCommands(manifest, 'win32')[1].shortcut).toBe('Ctrl+Shift+L')
  })

  it('refuses shortcuts without Ctrl, Command or Alt', () => {
    expect(parseExtensionShortcut('Shift+Y', 'win32')).toBeNull()
    expect(parseExtensionShortcut('MacCtrl+Shift+Y', 'darwin')).toMatchObject({
      control: true,
      meta: false
    })
  })
})
