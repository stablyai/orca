import { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { installMainWindowAgentStatusListeners } from './main-window-agent-status'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'

const { listener, send, popoutSend } = vi.hoisted(() => ({
  listener: vi.fn<(listener: (row: EnrichedAgentHookEventPayload) => void) => void>(),
  send: vi.fn(),
  popoutSend: vi.fn()
}))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { setListener: listener, setPaneStatusClearListener: vi.fn() }
}))
vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  setMigrationUnsupportedPtyListener: vi.fn()
}))
vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () => ({ webContents: { send: popoutSend } })
}))
vi.mock('./synthetic-title-runtime', () => ({ stopSyntheticTitleSpinnerTimer: vi.fn() }))
vi.mock('./main-process-state', () => ({
  mainProcessState: { mainWindow: { isDestroyed: () => false, webContents: { send } } }
}))

it('withholds a held root end in live/replayed IPC and publishes that same end after child release', () => {
  installMainWindowAgentStatusListeners({
    window: new BrowserWindow(),
    onRecordAgentState: vi.fn()
  })
  const publish = listener.mock.calls[0][0]
  const row: EnrichedAgentHookEventPayload = {
    paneKey: 'pane',
    connectionId: null,
    receivedAt: 200,
    stateStartedAt: 1,
    turnEndedAt: 100,
    turnEndDisposition: 'identified',
    payload: {
      agentType: 'codex',
      state: 'working',
      prompt: 'Finish',
      mainAgent: { state: 'done', stateStartedAt: 1, outcome: 'failure', usageLimit: {} }
    }
  }
  for (const isReplay of [false, true]) {
    publish({ ...row, isReplay })
    expect(send.mock.calls.at(-1)?.[1]).not.toHaveProperty('turnEndedAt')
    expect(popoutSend.mock.calls.at(-1)?.[1]).not.toHaveProperty('turnEndDisposition')
  }
  publish({ ...row, payload: { ...row.payload, state: 'done' } })
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    state: 'done',
    turnEndedAt: 100,
    turnEndDisposition: 'identified'
  })
  expect(popoutSend.mock.calls.at(-1)?.[1]).toMatchObject({ turnEndedAt: 100 })
})
