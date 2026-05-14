import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

import { registerKeybindingHandlers } from './keybindings'
import type { KeybindingSnapshot } from '../../shared/keybindings/keybinding-types'

describe('registerKeybindingHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
  })

  it('registers snapshot and reload handlers', async () => {
    // Arrange
    const snapshot = keybindingSnapshot(1)
    const reloaded = keybindingSnapshot(2)
    const service = {
      getSnapshot: vi.fn(() => snapshot),
      reload: vi.fn(() => reloaded),
      openConfig: vi.fn(),
      revealConfig: vi.fn()
    }

    // Act
    registerKeybindingHandlers(service)
    const getHandler = handleMock.mock.calls.find(
      (call) => call[0] === 'keybindings:getSnapshot'
    )?.[1] as () => KeybindingSnapshot
    const reloadHandler = handleMock.mock.calls.find(
      (call) => call[0] === 'keybindings:reload'
    )?.[1] as (event: {
      sender: { send: (channel: string, snapshot: KeybindingSnapshot) => void }
    }) => KeybindingSnapshot
    const sender = { send: vi.fn() }

    // Assert
    expect(getHandler()).toEqual(snapshot)
    expect(reloadHandler({ sender })).toEqual(reloaded)
    expect(sender.send).toHaveBeenCalledWith('keybindings:changed', reloaded)
    expect(handleMock.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        'keybindings:getSnapshot',
        'keybindings:reload',
        'keybindings:openConfig',
        'keybindings:revealConfig'
      ])
    )
  })
})

function keybindingSnapshot(loadedAt: number): KeybindingSnapshot {
  return {
    configPath: '/home/will/.orca/keybindings.toml',
    displayPath: '~/.orca/keybindings.toml',
    fileState: 'loaded',
    loadedAt,
    keymap: {
      platform: 'linux',
      diagnostics: [],
      bindings: []
    }
  }
}
