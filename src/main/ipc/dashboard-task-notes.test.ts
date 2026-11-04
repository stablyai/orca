import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  main: { id: 1 },
  popout: { id: 2, send: vi.fn() },
  sendMain: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn)
  }
}))
vi.mock('./ui', () => ({
  isTrustedUIRenderer: (sender: unknown) => sender === mocks.main,
  sendToTrustedUIRenderer: mocks.sendMain
}))
vi.mock('../window/dashboard-popout-window', () => ({
  isDashboardPopoutRenderer: (sender: unknown) => sender === mocks.popout,
  getDashboardPopoutWindow: () => ({ webContents: mocks.popout })
}))
import { registerDashboardTaskNoteHandlers } from './dashboard-task-notes'
const change = {
  key: JSON.stringify(['local', 'local', 'repo', 'folder', 'pane']),
  note: {
    status: 'automatic',
    title: 'Task',
    summary: '',
    nextStep: '',
    owner: '',
    reviewReference: '',
    observation: '',
    savedAt: 1
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
})
describe('dashboard task note IPC', () => {
  function setup(enabled = true) {
    const store = {
      getSettings: () => ({ experimentalAgentDashboardPopout: enabled }),
      loadDashboardTaskNotes: vi.fn(async () => ({ [change.key]: change.note })),
      setDashboardTaskNote: vi.fn(async () => change)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test supplies every Store method used by these handlers.
    registerDashboardTaskNoteHandlers(store as unknown as Store)
    return store
  }
  it('admits either dashboard view and broadcasts durable changes to both', async () => {
    const store = setup()
    for (const sender of [mocks.main, mocks.popout]) {
      expect(await mocks.handlers.get('dashboard:taskNotes:get')!({ sender })).toEqual({
        [change.key]: change.note
      })
      await mocks.handlers.get('dashboard:taskNotes:set')!({ sender }, change)
    }
    expect(store.setDashboardTaskNote).toHaveBeenCalledTimes(2)
    expect(mocks.sendMain).toHaveBeenLastCalledWith('dashboard:taskNotes:changed', change)
    expect(mocks.popout.send).toHaveBeenLastCalledWith('dashboard:taskNotes:changed', change)
  })
  it('rejects unrelated senders, malformed input and disabled feature access', async () => {
    const store = setup()
    expect(() => mocks.handlers.get('dashboard:taskNotes:get')!({ sender: { id: 3 } })).toThrow()
    await expect(
      mocks.handlers.get('dashboard:taskNotes:set')!({ sender: { id: 3 } }, change)
    ).rejects.toThrow()
    await expect(
      mocks.handlers.get('dashboard:taskNotes:set')!(
        { sender: mocks.main },
        { ...change, key: '__proto__' }
      )
    ).rejects.toThrow()
    expect(store.setDashboardTaskNote).not.toHaveBeenCalled()
    setup(false)
    expect(() => mocks.handlers.get('dashboard:taskNotes:get')!({ sender: mocks.popout })).toThrow()
  })
  it('does not broadcast a failed durable save', async () => {
    setup().setDashboardTaskNote.mockRejectedValueOnce(new Error('disk full'))
    await expect(
      mocks.handlers.get('dashboard:taskNotes:set')!({ sender: mocks.main }, change)
    ).rejects.toThrow('disk full')
    expect(mocks.sendMain).not.toHaveBeenCalled()
    expect(mocks.popout.send).not.toHaveBeenCalled()
  })
})
