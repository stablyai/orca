import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingFileSnapshot } from '../../shared/keybindings'

const { getAllWindowsMock, handleMock, openPathMock, rebuildAppMenuMock, showItemInFolderMock } =
  vi.hoisted(() => ({
    getAllWindowsMock: vi.fn(() => []),
    handleMock: vi.fn(),
    openPathMock: vi.fn(),
    rebuildAppMenuMock: vi.fn(),
    showItemInFolderMock: vi.fn()
  }))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock
  },
  ipcMain: {
    handle: handleMock
  },
  shell: {
    openPath: openPathMock,
    showItemInFolder: showItemInFolderMock
  }
}))

vi.mock('../menu/register-app-menu', () => ({
  rebuildAppMenu: rebuildAppMenuMock
}))

import { registerKeybindingHandlers } from './keybindings'

const snapshot: KeybindingFileSnapshot = {
  path: '/Users/example/.orca/keybindings.json',
  platform: 'darwin',
  exists: true,
  overrides: {},
  commonOverrides: {},
  platformOverrides: {},
  diagnostics: []
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!call) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return call[1] as (...args: unknown[]) => unknown
}

describe('registerKeybindingHandlers', () => {
  beforeEach(() => {
    getAllWindowsMock.mockReturnValue([])
    handleMock.mockReset()
    openPathMock.mockReset()
    rebuildAppMenuMock.mockReset()
    showItemInFolderMock.mockReset()
  })

  it('returns the keybindings file when ensuring it exists', () => {
    registerKeybindingHandlers({ ensureFile: vi.fn(() => snapshot) } as never)

    expect(getHandler('keybindings:ensureFile')()).toBe(snapshot)
  })

  it('reconciles plugin command conflicts after a shortcut edit', () => {
    const onChanged = vi.fn()
    const setActionBindings = vi.fn(() => snapshot)
    registerKeybindingHandlers({ setActionBindings } as never, onChanged)

    expect(
      getHandler('keybindings:setAction')(
        {},
        {
          actionId: 'plugin:orca-samples.tasks/open',
          bindings: ['Mod+Shift+T']
        }
      )
    ).toBe(snapshot)
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('opens the keybindings file outside Orca', async () => {
    openPathMock.mockResolvedValue('')
    registerKeybindingHandlers({ ensureFile: vi.fn(() => snapshot) } as never)

    await expect(getHandler('keybindings:openFile')()).resolves.toBe(snapshot)
    expect(openPathMock).toHaveBeenCalledWith(snapshot.path)
  })
})
