import { describe, expect, it, vi } from 'vitest'
import {
  createUserKeybindingService,
  createUserKeybindingServiceFromDisk
} from './keybinding-service'

describe('createUserKeybindingService', () => {
  it('should cache a snapshot and reload it from the user TOML file', () => {
    // Arrange
    const readTextFile = vi
      .fn()
      .mockReturnValueOnce({ ok: false, reason: 'missing' })
      .mockReturnValueOnce({
        ok: true,
        text: `
[keybindings.linux]
"terminal.paste" = "ctrl+shift+v"
`
      })
    const service = createUserKeybindingService({
      homeDirectory: '/home/will',
      platform: 'linux',
      readTextFile,
      now: vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2),
      openConfig: vi.fn(),
      revealConfig: vi.fn()
    })

    // Act
    const first = service.getSnapshot()
    const second = service.reload()

    // Assert
    expect(first.fileState).toBe('missing')
    expect(second.fileState).toBe('loaded')
    expect(second.loadedAt).toBe(2)
    expect(second.keymap.bindings.find((binding) => binding.id === 'terminal.paste')).toEqual(
      expect.objectContaining({ source: 'user' })
    )
  })
})

describe('createUserKeybindingServiceFromDisk', () => {
  it('should create a starter config before opening a missing keybindings file', async () => {
    // Arrange
    const files = new Map<string, string>()
    const openPath = vi.fn()
    const showItemInFolder = vi.fn()
    const service = createUserKeybindingServiceFromDisk({
      homeDirectory: '/home/will',
      platform: 'linux',
      now: () => 1,
      existsSync: (path) => files.has(path),
      mkdirSync: vi.fn(),
      readFileSync: (path) => {
        const text = files.get(path)
        if (text == null) {
          throw new Error('missing')
        }
        return text
      },
      writeFileSync: (path, text) => {
        files.set(path, text)
      },
      openPath,
      showItemInFolder
    })

    // Act
    await service.openConfig()
    await service.revealConfig()

    // Assert
    const starter = files.get('/home/will/.orca/keybindings.toml')
    expect(starter).toContain('[keybindings.linux]')
    expect(starter).toContain('"terminal.copySelection" = ["ctrl+insert", "ctrl+shift+c"]')
    expect(starter).toContain('"terminal.paste" = ["shift+insert", "ctrl+shift+v"]')
    expect(starter).toContain('[keybindings.macos]')
    expect(starter).toContain('[keybindings.windows]')
    expect(openPath).toHaveBeenCalledWith('/home/will/.orca/keybindings.toml')
    expect(showItemInFolder).toHaveBeenCalledWith('/home/will/.orca/keybindings.toml')
  })
})
