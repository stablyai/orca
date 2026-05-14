import { describe, expect, it } from 'vitest'
import { join } from 'path'
import {
  displayUserKeybindingConfigPath,
  loadUserKeybindingConfig,
  nodePlatformToKeybindingPlatform,
  parseUserKeybindingConfigToml,
  userKeybindingConfigPath
} from './user-keybinding-config'

describe('parseUserKeybindingConfigToml', () => {
  it('should merge shared and platform-specific keybinding tables for the active platform', () => {
    // Arrange
    const source = `
[keybindings]
"quickOpen.open" = "ctrl+p"

[keybindings.linux]
"terminal.paste" = ["ctrl+shift+v", "shift+insert"]
"sidebar.left.toggle" = "none"

[keybindings.macos]
"terminal.paste" = "cmd+v"
`

    // Act
    const result = parseUserKeybindingConfigToml(source, 'linux')

    // Assert
    expect(result).toEqual({
      overrides: {
        'quickOpen.open': 'ctrl+p',
        'terminal.paste': ['ctrl+shift+v', 'shift+insert'],
        'sidebar.left.toggle': 'none'
      },
      diagnostics: []
    })
  })
})

describe('loadUserKeybindingConfig', () => {
  it('should build defaults when the keybindings file is missing', () => {
    // Arrange
    const configPath = join('/home/will', '.orca', 'keybindings.toml')

    // Act
    const result = loadUserKeybindingConfig({
      configPath,
      platform: 'linux',
      readTextFile: () => ({ ok: false, reason: 'missing' })
    })

    // Assert
    expect(result.configPath).toBe(configPath)
    expect(result.keymap.diagnostics).toEqual([])
    expect(result.keymap.bindings.find((binding) => binding.id === 'terminal.paste')).toEqual(
      expect.objectContaining({
        source: 'default',
        command: { type: 'terminalPaste' }
      })
    )
  })

  it('should build an Effective Keymap from loaded TOML overrides', () => {
    // Arrange
    const configPath = join('/home/will', '.orca', 'keybindings.toml')

    // Act
    const result = loadUserKeybindingConfig({
      configPath,
      platform: 'linux',
      readTextFile: () => ({
        ok: true,
        text: `
[keybindings.linux]
"terminal.paste" = "ctrl+shift+v"
`
      })
    })

    // Assert
    expect(result.fileState).toBe('loaded')
    expect(result.keymap.bindings.find((binding) => binding.id === 'terminal.paste')).toEqual(
      expect.objectContaining({
        source: 'user',
        chords: [expect.objectContaining({ ctrl: true, shift: true, key: 'v' })]
      })
    )
  })

  it('should mark malformed TOML without applying partial overrides', () => {
    const result = loadUserKeybindingConfig({
      configPath: join('/home/will', '.orca', 'keybindings.toml'),
      platform: 'linux',
      readTextFile: () => ({
        ok: true,
        text: `
[keybindings.linux]
"terminal.paste" = [
`
      })
    })

    expect(result.fileState).toBe('malformed')
    expect(result.keymap.bindings.find((binding) => binding.id === 'terminal.paste')).toEqual(
      expect.objectContaining({ source: 'default' })
    )
  })
})

describe('user keybinding config paths', () => {
  it('should resolve the per-user keybindings.toml path cross-platform', () => {
    expect(userKeybindingConfigPath('/Users/will')).toBe(
      join('/Users/will', '.orca', 'keybindings.toml')
    )
    expect(displayUserKeybindingConfigPath('win32')).toBe('%USERPROFILE%\\.orca\\keybindings.toml')
    expect(displayUserKeybindingConfigPath('linux')).toBe('~/.orca/keybindings.toml')
  })

  it('should map supported Node platforms to keybinding platforms', () => {
    expect(nodePlatformToKeybindingPlatform('darwin')).toBe('macos')
    expect(nodePlatformToKeybindingPlatform('win32')).toBe('windows')
    expect(nodePlatformToKeybindingPlatform('linux')).toBe('linux')
  })
})
