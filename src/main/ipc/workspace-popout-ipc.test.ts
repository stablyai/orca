import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePopoutTarget } from '../../shared/workspace-popout/workspace-popout-contract'

const {
  handlers,
  isTrustedUIRendererMock,
  isWorkspacePopoutRendererMock,
  getWorkspacePopoutEntryMock,
  getWorkspacePopoutTargetMock,
  createOrFocusPopoutMock,
  dockPopoutMock,
  closeAllPopoutsMock,
  listPopoutsMock,
  setPopoutTargetMock
} = vi.hoisted(() => {
  type IpcHandler = (...args: unknown[]) => unknown
  const handlers = new Map<string, IpcHandler>()
  return {
    handlers,
    isTrustedUIRendererMock: vi.fn(),
    isWorkspacePopoutRendererMock: vi.fn(),
    getWorkspacePopoutEntryMock: vi.fn(),
    getWorkspacePopoutTargetMock: vi.fn(),
    createOrFocusPopoutMock: vi.fn(),
    dockPopoutMock: vi.fn(),
    closeAllPopoutsMock: vi.fn(),
    listPopoutsMock: vi.fn(),
    setPopoutTargetMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn))
  }
}))

vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

vi.mock('../window/workspace-popout-window', () => ({
  closeAllWorkspacePopouts: closeAllPopoutsMock,
  createOrFocusWorkspacePopout: createOrFocusPopoutMock,
  dockWorkspacePopout: dockPopoutMock,
  focusWorkspacePopout: vi.fn(() => true),
  getWorkspacePopoutEntryForWebContents: getWorkspacePopoutEntryMock,
  getWorkspacePopoutTarget: getWorkspacePopoutTargetMock,
  isWorkspacePopoutRenderer: isWorkspacePopoutRendererMock,
  listWorkspacePopouts: listPopoutsMock,
  setWorkspacePopoutTarget: setPopoutTargetMock
}))

import { registerWorkspacePopoutHandlers } from './workspace-popout'
import type { Store } from '../persistence/loading-store/store'

describe('workspace-popout-ipc', () => {
  let settingsCallback:
    | ((updates: Record<string, unknown>, settings: Record<string, unknown>) => void)
    | null = null
  let settingsState = { experimentalWorkspacePopout: true }

  const mockStore = {
    getSettings: () => settingsState,
    onSettingsChanged: (
      cb: (updates: Record<string, unknown>, settings: Record<string, unknown>) => void
    ) => {
      settingsCallback = cb
      return () => {
        settingsCallback = null
      }
    }
  } as unknown as Store

  const validTarget: WorkspacePopoutTarget = {
    worktreeId: 'wt-123',
    tabId: 'tab-1',
    ptyId: 'pty-1',
    terminalInput: null,
    title: 'Terminal 1'
  }

  const trustedSender = { id: 1 } as unknown as Electron.WebContents
  const untrustedSender = { id: 99 } as unknown as Electron.WebContents
  const satelliteSender = { id: 2 } as unknown as Electron.WebContents

  beforeEach(() => {
    settingsState = { experimentalWorkspacePopout: true }
    vi.clearAllMocks()
    handlers.clear()
    registerWorkspacePopoutHandlers(mockStore)

    isTrustedUIRendererMock.mockImplementation((s: unknown) => s === trustedSender)
    isWorkspacePopoutRendererMock.mockImplementation((s: unknown) => s === satelliteSender)
    getWorkspacePopoutEntryMock.mockImplementation((s: unknown) => {
      if (s === satelliteSender) {
        return { worktreeId: 'wt-123' }
      }
      return null
    })
  })

  describe('workspacePopout:open', () => {
    const invokeOpen = (sender: unknown, payload: unknown) =>
      handlers.get('workspacePopout:open')?.({ sender }, payload)

    it('rejects untrusted sender without instantiating window', () => {
      const res = invokeOpen(untrustedSender, validTarget)
      expect(res).toEqual({ status: 'rejected', reason: 'invalid-payload' })
      expect(createOrFocusPopoutMock).not.toHaveBeenCalled()
    })

    it('rejects when experimental flag is disabled', () => {
      settingsState.experimentalWorkspacePopout = false
      const res = invokeOpen(trustedSender, validTarget)
      expect(res).toEqual({ status: 'rejected', reason: 'flag-disabled' })
      expect(createOrFocusPopoutMock).not.toHaveBeenCalled()
    })

    it('rejects malformed payload without throwing', () => {
      const res = invokeOpen(trustedSender, { worktreeId: '' })
      expect(res).toEqual({ status: 'rejected', reason: 'invalid-payload' })
      expect(createOrFocusPopoutMock).not.toHaveBeenCalled()
    })

    it('rejects remote runtime PTY', () => {
      const res = invokeOpen(trustedSender, { ...validTarget, ptyId: 'remote:env@@pty' })
      expect(res).toEqual({ status: 'rejected', reason: 'remote-runtime-pty' })
      expect(createOrFocusPopoutMock).not.toHaveBeenCalled()
    })

    it('calls createOrFocusWorkspacePopout with valid payload and trusted sender', () => {
      createOrFocusPopoutMock.mockReturnValue({ status: 'opened' })
      const res = invokeOpen(trustedSender, validTarget)
      expect(res).toEqual({ status: 'opened' })
      expect(createOrFocusPopoutMock).toHaveBeenCalledWith(
        mockStore,
        validTarget,
        expect.any(Object)
      )
    })
  })

  describe('workspacePopout:publishTarget', () => {
    const invokePublish = (sender: unknown, payload: unknown) =>
      handlers.get('workspacePopout:publishTarget')?.({ sender }, payload)

    it('ignores untrusted sender', () => {
      invokePublish(untrustedSender, validTarget)
      expect(setPopoutTargetMock).not.toHaveBeenCalled()
    })

    it('ignores malformed payload', () => {
      invokePublish(trustedSender, { invalid: true })
      expect(setPopoutTargetMock).not.toHaveBeenCalled()
    })

    it('calls setWorkspacePopoutTarget for valid target from trusted sender', () => {
      invokePublish(trustedSender, validTarget)
      expect(setPopoutTargetMock).toHaveBeenCalledWith('wt-123', validTarget)
    })
  })

  describe('workspacePopout:dock', () => {
    const invokeDock = (sender: unknown, payload: unknown) =>
      handlers.get('workspacePopout:dock')?.({ sender }, payload)

    it('ignores invalid payload', () => {
      invokeDock(trustedSender, null)
      expect(dockPopoutMock).not.toHaveBeenCalled()
    })

    it('allows trusted main renderer to dock any worktree', () => {
      invokeDock(trustedSender, { worktreeId: 'wt-other' })
      expect(dockPopoutMock).toHaveBeenCalledWith('wt-other')
    })

    it('allows satellite renderer to dock its own worktree', () => {
      invokeDock(satelliteSender, { worktreeId: 'wt-123' })
      expect(dockPopoutMock).toHaveBeenCalledWith('wt-123')
    })

    it('rejects satellite renderer attempting to dock another worktree', () => {
      invokeDock(satelliteSender, { worktreeId: 'wt-other' })
      expect(dockPopoutMock).not.toHaveBeenCalled()
    })

    it('rejects untrusted sender', () => {
      invokeDock(untrustedSender, { worktreeId: 'wt-123' })
      expect(dockPopoutMock).not.toHaveBeenCalled()
    })
  })

  describe('workspacePopout:list', () => {
    it('returns empty array for untrusted sender', () => {
      const res = handlers.get('workspacePopout:list')?.({ sender: untrustedSender })
      expect(res).toEqual([])
      expect(listPopoutsMock).not.toHaveBeenCalled()
    })

    it('returns popout summaries for trusted sender', () => {
      listPopoutsMock.mockReturnValue([
        { worktreeId: 'wt-1', tabId: 'tab-1', ptyId: 'pty-1', state: 'open' }
      ])
      const res = handlers.get('workspacePopout:list')?.({ sender: trustedSender })
      expect(res).toEqual([{ worktreeId: 'wt-1', tabId: 'tab-1', ptyId: 'pty-1', state: 'open' }])
    })
  })

  describe('workspacePopout:getTarget', () => {
    it('returns null for untrusted sender', () => {
      const res = handlers.get('workspacePopout:getTarget')?.({ sender: untrustedSender })
      expect(res).toBeNull()
      expect(getWorkspacePopoutTargetMock).not.toHaveBeenCalled()
    })

    it('returns target for authorized satellite sender', () => {
      getWorkspacePopoutTargetMock.mockReturnValue(validTarget)
      const res = handlers.get('workspacePopout:getTarget')?.({ sender: satelliteSender })
      expect(res).toEqual(validTarget)
      expect(getWorkspacePopoutTargetMock).toHaveBeenCalledWith(satelliteSender)
    })
  })

  describe('flag toggling lifecycle', () => {
    it('closes all popouts when experimentalWorkspacePopout becomes false', () => {
      settingsCallback?.(
        { experimentalWorkspacePopout: false },
        { experimentalWorkspacePopout: false }
      )
      expect(closeAllPopoutsMock).toHaveBeenCalledWith('flag-disabled')
    })
  })
})
