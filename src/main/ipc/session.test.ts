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

  it('patches only the sender window and requested host with local fallback intact', () => {
    const store = {
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      flush: vi.fn(),
      flushOrThrow: vi.fn(),
      readTerminalScrollbackSnapshot: vi.fn()
    }
    registerSessionHandlers(store as never)
    const event = { sender: { id: 101 } }
    getInvokeHandler('session:set')(event, makeSession('local-tab'))
    getInvokeHandler('session:set')(event, makeSession('ssh-tab'), 'ssh:server-1')

    getInvokeHandler('session:patch')(event, { activeTabId: 'ssh-patched' }, 'ssh:server-1')

    expect(getInvokeHandler('session:get')(event).activeTabId).toBe('local-tab')
    expect(getInvokeHandler('session:get')(event, 'ssh:server-1').activeTabId).toBe('ssh-patched')
    expect(store.setWorkspaceSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeTabId: 'ssh-patched' }),
      'ssh:server-1'
    )
  })

  it('trust-checks flush and synchronous scrollback reads', () => {
    const store = {
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      flush: vi.fn(),
      flushOrThrow: vi.fn(),
      readTerminalScrollbackSnapshot: vi.fn(() => 'scrollback')
    }
    registerSessionHandlers(store as never)
    const event = { sender: { id: 101 }, returnValue: undefined as unknown }

    getInvokeHandler('session:flush')(event)
    getSyncHandler('session:read-terminal-scrollback-sync')(event, { ref: 'snapshot/ref' })

    expect(store.flushOrThrow).toHaveBeenCalledOnce()
    expect(store.readTerminalScrollbackSnapshot).toHaveBeenCalledWith('snapshot/ref')
    expect(event.returnValue).toBe('scrollback')
  })

  it('rejects every session channel from an unregistered renderer', () => {
    const store = {
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      flush: vi.fn(),
      flushOrThrow: vi.fn(),
      readTerminalScrollbackSnapshot: vi.fn()
    }
    registerSessionHandlers(store as never)

    const event = { sender: { id: 999 }, returnValue: undefined as unknown }
    expect(() => getInvokeHandler('session:get')(event)).toThrow('untrusted_ui_renderer')
    expect(() => getInvokeHandler('session:set')(event, makeSession('tab'))).toThrow(
      'untrusted_ui_renderer'
    )
    expect(() => getInvokeHandler('session:patch')(event, { activeTabId: 'tab' })).toThrow(
      'untrusted_ui_renderer'
    )
    expect(() => getInvokeHandler('session:flush')(event)).toThrow('untrusted_ui_renderer')
    expect(() => getSyncHandler('session:set-sync')(event, makeSession('tab'))).toThrow(
      'untrusted_ui_renderer'
    )
    expect(() =>
      getSyncHandler('session:read-terminal-scrollback-sync')(event, { ref: 'snapshot/ref' })
    ).toThrow('untrusted_ui_renderer')
    expect(store.getWorkspaceSession).not.toHaveBeenCalled()
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flush).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(store.readTerminalScrollbackSnapshot).not.toHaveBeenCalled()
  })
})
