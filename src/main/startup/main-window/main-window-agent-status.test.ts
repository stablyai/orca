import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const { setListener, send } = vi.hoisted(() => ({ setListener: vi.fn(), send: vi.fn() }))
vi.mock('../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { setListener, setPaneStatusClearListener: () => {} }
}))
vi.mock('../../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('./synthetic-title-runtime', () => ({ stopSyntheticTitleSpinnerTimer: () => {} }))
vi.mock('../main-process-state', () => ({
  mainProcessState: { core: {}, mainWindow: { isDestroyed: () => false, webContents: { send } } }
}))

const { installMainWindowAgentStatusListeners } = await import('./main-window-agent-status')

it('tells the window that a tmux-hosted conversation is shared, so it writes no checkpoint', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listener never reads the window it is given.
  const window = {} as BrowserWindow
  installMainWindowAgentStatusListeners({ window, onRecordAgentState: () => {} })
  setListener.mock.lastCall![0]({
    executionHost: 'shared',
    paneKey: 'tab-1:pane-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    payload: { state: 'done', prompt: '', agentType: 'codex' },
    providerSession: { key: 'session_id', id: 'codex-in-tmux' }
  })
  expect(send).toHaveBeenCalledWith(
    'agentStatus:set',
    expect.objectContaining({ paneKey: 'tab-1:pane-1', executionHost: 'shared' })
  )
})

it("sends no identity for an agent that ended, so a quit conversation isn't checkpointed again", () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listener never reads the window it is given.
  const window = {} as BrowserWindow
  installMainWindowAgentStatusListeners({ window, onRecordAgentState: () => {} })
  send.mockClear()
  setListener.mock.lastCall![0]({
    paneKey: 'tab-1:pane-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    payload: { state: 'done', prompt: '', agentType: 'codex' },
    providerSession: { key: 'session_id', id: 'quit-codex' },
    providerSessionOnly: true,
    agentPresence: { agent: 'codex', ended: true }
  })
  expect(send).not.toHaveBeenCalled()
})
