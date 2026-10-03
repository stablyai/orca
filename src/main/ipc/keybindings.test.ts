import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { KeybindingFileSnapshot } from '../../shared/keybindings'

const {
  authorizeExternalPathMock,
  getAllWindowsMock,
  handleMock,
  openPathMock,
  spawnProcessMock,
  rebuildAppMenuMock,
  showItemInFolderMock
} = vi.hoisted(() => ({
  authorizeExternalPathMock: vi.fn(),
  getAllWindowsMock: vi.fn(() => []),
  handleMock: vi.fn(),
  openPathMock: vi.fn(),
  spawnProcessMock: vi.fn(),
  rebuildAppMenuMock: vi.fn(),
  showItemInFolderMock: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnProcessMock }))

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

vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: authorizeExternalPathMock
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
  let hostPlatform: PropertyDescriptor | undefined

  afterEach(() => {
    vi.useRealTimers()
    if (hostPlatform) {
      Object.defineProperty(process, 'platform', hostPlatform)
    }
  })

  beforeEach(() => {
    hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    spawnProcessMock.mockReset()
    authorizeExternalPathMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
    handleMock.mockReset()
    openPathMock.mockReset()
    rebuildAppMenuMock.mockReset()
    showItemInFolderMock.mockReset()
  })

  it('authorizes the keybindings file for in-app editing when ensuring it exists', () => {
    registerKeybindingHandlers({ ensureFile: vi.fn(() => snapshot) } as never)

    expect(getHandler('keybindings:ensureFile')()).toBe(snapshot)
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(snapshot.path)
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

  it('authorizes the keybindings file before opening it outside Orca', async () => {
    openPathMock.mockResolvedValue('')
    registerKeybindingHandlers({ ensureFile: vi.fn(() => snapshot) } as never)

    await expect(getHandler('keybindings:openFile')()).resolves.toBe(snapshot)
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(snapshot.path)
    expect(openPathMock).toHaveBeenCalledWith(snapshot.path)
  })

  it.each(['success', 'nonzero', 'missing', 'pending'] as const)(
    'reports a %s Linux keybindings launcher without losing path authorization',
    async (outcome) => {
      vi.useFakeTimers()
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      spawnProcessMock.mockImplementationOnce(() => {
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
        queueMicrotask(() => {
          if (outcome === 'missing') {
            child.emit('error', new Error('spawn xdg-open ENOENT'))
          } else if (outcome !== 'pending') {
            child.emit('exit', outcome === 'success' ? 0 : 1, null)
          }
        })
        return child
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler only calls ensureFile on the fixture service.
      registerKeybindingHandlers({ ensureFile: vi.fn(() => snapshot) } as never)
      const opened = getHandler('keybindings:openFile')()
      const assertion =
        outcome === 'success'
          ? expect(opened).resolves.toBe(snapshot)
          : expect(opened).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(1_500)
      await assertion
      expect(authorizeExternalPathMock).toHaveBeenCalledWith(snapshot.path)
      expect(spawnProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({ args: [snapshot.path] })
      )
      expect(openPathMock).not.toHaveBeenCalled()
    }
  )
})
