import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { retainTmuxWriterTopology } from '../../agent-hooks/server/cli-writer-observation'

const { setListener, send } = vi.hoisted(() => ({ setListener: vi.fn(), send: vi.fn() }))
vi.mock('../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { setListener, setPaneStatusClearListener: () => {} }
}))
vi.mock('../../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('./synthetic-title-runtime', () => ({ stopSyntheticTitleSpinnerTimer: () => {} }))
vi.mock('../main-process-state', () => ({
  mainProcessState: { mainWindow: { isDestroyed: () => false, webContents: { send } } }
}))

const { installMainWindowAgentStatusListeners } = await import('./main-window-agent-status')

it('tells the window that a tmux-hosted conversation is shared, so it writes no checkpoint', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listener only forwards status to this window.
  installMainWindowAgentStatusListeners({
    window: {} as BrowserWindow,
    onRecordAgentState: () => {}
  })
  const providerSession = { key: 'session_id' as const, id: 'codex-in-tmux' }
  retainTmuxWriterTopology(providerSession)
  setListener.mock.lastCall![0]({
    paneKey: 'tab-1:pane-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    payload: { state: 'done', prompt: '', agentType: 'codex' },
    providerSession
  })
  expect(send).toHaveBeenCalledWith(
    'agentStatus:set',
    expect.objectContaining({ paneKey: 'tab-1:pane-1', sharedHost: true })
  )
})
