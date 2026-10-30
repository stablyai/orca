import { describe, expect, it } from 'vitest'
import {
  parseExtensionShortcut,
  readBrowserExtensionCommands,
  shortcutMatchesInput
} from './browser-extension-commands'

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

function key(input: Partial<Electron.Input>): Electron.Input {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...input
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

  it('assigns suggested keys to at most four commands', () => {
    const many = {
      commands: Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e'].map((name, index) => [
          name,
          { suggested_key: { default: `Alt+Shift+${index}` } }
        ])
      )
    }
    expect(readBrowserExtensionCommands(many, 'win32').map((c) => c.shortcut)).toEqual([
      'Alt+Shift+0',
      'Alt+Shift+1',
      'Alt+Shift+2',
      'Alt+Shift+3',
      ''
    ])
  })

  it('refuses shortcuts without Ctrl, Command or Alt', () => {
    expect(parseExtensionShortcut('Shift+Y', 'win32')).toBeNull()
    expect(parseExtensionShortcut('MacCtrl+Shift+Y', 'darwin')).toMatchObject({
      control: true,
      meta: false
    })
  })

  it('matches the physical key so Option and Shift variants still fire', () => {
    const [openPopup] = readBrowserExtensionCommands(manifest, 'darwin')
    const binding = openPopup.binding
    expect(binding).not.toBeNull()
    if (!binding) {
      return
    }
    expect(
      shortcutMatchesInput(binding, key({ key: 'Y', code: 'KeyY', meta: true, shift: true }))
    ).toBe(true)
    expect(
      shortcutMatchesInput(binding, key({ key: 'Y', code: 'KeyY', control: true, shift: true }))
    ).toBe(false)
  })
})
