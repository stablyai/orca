import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'

const { handleMock, onMock, windowBySenderId } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  windowBySenderId: new Map<number, { id: number }>()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: onMock }
}))

vi.mock('../window/orca-window-manager', () => ({
  orcaWindowManager: {
    getControlWindow: () => windowBySenderId.get(101) ?? null,
    getWindowForSender: (sender: { id: number }) => windowBySenderId.get(sender.id) ?? null
  }
}))

import { registerSessionHandlers } from './session'

function makeSession(tabId: string) {
  const worktreeId = 'repo::/worktree'
  return {
    ...getDefaultWorkspaceSession(),
    activeTabId: tabId,
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: tabId,
          worktreeId,
          title: tabId,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: `pty-${tabId}`
        }
      ]
    }
  }
}

function getInvokeHandler(channel: string) {
  return handleMock.mock.calls.find(([candidate]) => candidate === channel)?.[1]
}

function getSyncHandler(channel: string) {
  return onMock.mock.calls.find(([candidate]) => candidate === channel)?.[1]
}

describe('session IPC window partitioning', () => {
  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
    windowBySenderId.clear()
    windowBySenderId.set(101, { id: 1 })
    windowBySenderId.set(102, { id: 2 })
  })

  it('returns and writes the record owned by event.sender', () => {
    const store = {
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      flush: vi.fn(),
      flushOrThrow: vi.fn(),
      readTerminalScrollbackSnapshot: vi.fn()
    }
    registerSessionHandlers(store as never)
    const set = getInvokeHandler('session:set')
    const get = getInvokeHandler('session:get')

    set({ sender: { id: 101 } }, makeSession('tab-a'))
    set({ sender: { id: 102 } }, makeSession('tab-b'))

    expect(get({ sender: { id: 101 } }).activeTabId).toBe('tab-a')
    expect(get({ sender: { id: 102 } }).activeTabId).toBe('tab-b')
    expect(store.setWorkspaceSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabsByWorktree: expect.objectContaining({
          'repo::/worktree': expect.arrayContaining([
            expect.objectContaining({ id: 'tab-a' }),
            expect.objectContaining({ id: 'tab-b' })
          ])
        })
      }),
      'local'
    )
  })

  it('routes synchronous set through the same window registry', () => {
    const store = {
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      flush: vi.fn(),
      flushOrThrow: vi.fn(),
      readTerminalScrollbackSnapshot: vi.fn()
    }
    registerSessionHandlers(store as never)
    const setSync = getSyncHandler('session:set-sync')
    const event = { sender: { id: 102 }, returnValue: undefined as unknown }

    setSync(event, makeSession('tab-sync'))

    expect(event.returnValue).toBe(true)
    expect(store.setWorkspaceSession).toHaveBeenCalledWith(
      expect.objectContaining({ activeTabId: 'tab-sync' }),
      'local'
    )
    expect(store.flush).toHaveBeenCalledOnce()
  })

  it('rejects session access from an unregistered renderer', () => {
    const store = {
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      flush: vi.fn(),
      flushOrThrow: vi.fn(),
      readTerminalScrollbackSnapshot: vi.fn()
    }
    registerSessionHandlers(store as never)

    expect(() => getInvokeHandler('session:get')({ sender: { id: 999 } })).toThrow(
      'untrusted_ui_renderer'
    )
    expect(store.getWorkspaceSession).not.toHaveBeenCalled()
  })
})
