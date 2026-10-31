import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), send: vi.fn(), show: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, removeHandler: vi.fn() } }))
vi.mock('../ipc/ui', () => ({
  getTrustedUIRendererWindow: () => ({ webContents: { id: 7, send: mocks.send } })
}))
vi.mock('./main-window-actions', () => ({ showMainWindowFromTray: mocks.show }))
import {
  openAutomationRun,
  registerAutomationRunNavigation,
  clearAutomationRunNavigation
} from './automation-run-navigation'
beforeEach(() => {
  vi.clearAllMocks()
  clearAutomationRunNavigation()
})
it('retains the click across renderer startup, consumes once, and refuses another renderer', async () => {
  const target = { automationId: 'automation', runId: 'run', hostId: 'runtime:server' } as const
  openAutomationRun(target)
  registerAutomationRunNavigation()
  const consume = mocks.handle.mock.calls[0][1]
  await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledOnce())
  expect(mocks.send).toHaveBeenCalledWith('automations:openRun')
  expect(consume({ sender: { id: 8 } })).toBeNull()
  expect(consume({ sender: { id: 7 } })).toEqual(target)
  expect(consume({ sender: { id: 7 } })).toBeNull()
  openAutomationRun(target)
  clearAutomationRunNavigation()
  expect(consume({ sender: { id: 7 } })).toBeNull()
})
