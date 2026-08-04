import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingFileSnapshot } from '../../shared/keybindings'

const {
  authorizeExternalPathMock,
  getAllWindowsMock,
  handleMock,
  openPathMock,
  rebuildAppMenuMock,
  showItemInFolderMock
} = vi.hoisted(() => ({
  authorizeExternalPathMock: vi.fn(),
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
  beforeEach(() => {
    authorizeExternalPathMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
    handleMock.mockReset()
    openPathMock.mockReset()
    rebuildAppMenuMock.mockReset()
    showItemInFolderMock.mockReset()
  })

  it('authorizes the keybindings file for in-app editing when ensuring it exists', async () => {
    registerKeybindingHandlers({ ensureFile: vi.fn(() => snapshot) } as never)

    await expect(getHandler('keybindings:ensureFile')()).resolves.toBe(snapshot)
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

  it('retries failed startup hydration and broadcasts the recovered shortcuts', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    getAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } }
    ] as never)
    let needsRetry = true
    const recovered = { ...snapshot, overrides: { 'tab.nextAllTypes': ['Mod+K'] } }
    const hydrate = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(async () => {
        needsRetry = false
        return recovered
      })
    const onChanged = vi.fn()

    try {
      registerKeybindingHandlers(
        {
          hydrate,
          needsHydrationRetry: () => needsRetry,
          getSnapshot: () => snapshot
        } as never,
        onChanged
      )
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(100)

      expect(hydrate).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledWith('keybindings:changed', recovered)
      expect(rebuildAppMenuMock).toHaveBeenCalledOnce()
      expect(onChanged).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deduplicates startup hydration across handler registration', async () => {
    let release!: (value: typeof snapshot) => void
    const hydrate = vi.fn(
      async () =>
        await new Promise<typeof snapshot>((resolve) => {
          release = resolve
        })
    )
    let needsRetry = true
    const service = {
      hydrate,
      needsHydrationRetry: () => needsRetry,
      getSnapshot: () => snapshot
    } as never

    registerKeybindingHandlers(service)
    registerKeybindingHandlers(service)

    expect(hydrate).toHaveBeenCalledOnce()
    needsRetry = false
    release(snapshot)
    await Promise.resolve()
  })
})
