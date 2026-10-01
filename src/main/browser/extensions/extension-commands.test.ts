import { describe, expect, it } from 'vitest'
import { findBrowserExtensionCommand, listBrowserExtensionCommands } from './extension-commands'

const onePassword = {
  id: 'onepassword',
  manifest: {
    commands: {
      _execute_action: { suggested_key: { default: 'Ctrl+Shift+X', mac: 'Command+Shift+X' } },
      lock: { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' } }
    }
  }
}

function keyDown(input: Partial<Electron.Input>): Electron.Input {
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

function find(input: Partial<Electron.Input>, platform: NodeJS.Platform) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lookup reads only id and manifest.
  return findBrowserExtensionCommand([onePassword as never], keyDown(input), platform)
}

describe('findBrowserExtensionCommand', () => {
  it('matches the platform shortcut by key code', () => {
    const chord = { code: 'KeyX', key: 'X', shift: true }
    expect(find({ ...chord, meta: true }, 'darwin')).toEqual({
      extensionId: 'onepassword',
      name: '_execute_action'
    })
    expect(find({ ...chord, control: true }, 'win32')?.name).toBe('_execute_action')
    expect(find({ ...chord, control: true }, 'darwin')).toBeNull()
  })

  it('needs the exact modifiers and ignores key repeat', () => {
    expect(find({ code: 'KeyL', meta: true }, 'darwin')).toBeNull()
    expect(find({ code: 'KeyL', meta: true, shift: true, alt: true }, 'darwin')).toBeNull()
    expect(find({ code: 'KeyL', meta: true, shift: true }, 'darwin')?.name).toBe('lock')
    expect(find({ code: 'KeyL', meta: true, shift: true, isAutoRepeat: true }, 'darwin')).toBeNull()
  })

  it('reads "Ctrl" as Command on macOS and "MacCtrl" as Control', () => {
    const extension = {
      id: 'ext',
      manifest: {
        commands: { a: { suggested_key: 'Ctrl+Comma' }, b: { suggested_key: 'MacCtrl+Up' } }
      }
    }
    const run = (input: Partial<Electron.Input>) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lookup reads only id and manifest.
      findBrowserExtensionCommand([extension as never], keyDown(input), 'darwin')?.name
    expect(run({ key: ',', meta: true })).toBe('a')
    expect(run({ key: 'ArrowUp', control: true })).toBe('b')
  })
})

describe('listBrowserExtensionCommands', () => {
  it('writes shortcuts as Chrome shows them on each platform', () => {
    const names = (platform: NodeJS.Platform) =>
      listBrowserExtensionCommands(onePassword, platform).map((each) => each.shortcut)
    expect(names('darwin')).toEqual(['⇧⌘X', '⇧⌘L'])
    expect(names('win32')).toEqual(['Ctrl+Shift+X', 'Ctrl+Shift+L'])
  })
})
