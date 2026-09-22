// STA-2864, fourth defect, consumer half. The desktop window's status handler opened with
// `if (state.mainWindow?.isDestroyed()) { return }`, and the dashboard pop-out's send sat
// inside it — so a torn-down main window silenced a window that was still on screen.
//
// The window is now a subscriber like any other: it delivers to whichever surfaces are alive,
// and closing it ends its subscription instead of nulling a slot every consumer shared.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server'
import type { AgentStatusClearIpcPayload } from '../../shared/agent-status-types'

type StatusListener = (payload: EnrichedAgentHookEventPayload) => void
type ClearListener = (clear: AgentStatusClearIpcPayload) => void

const hooks = vi.hoisted(() => ({
  statusListeners: new Set<StatusListener>(),
  clearListeners: new Set<ClearListener>(),
  replayRequests: new Array<boolean | undefined>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '', on: vi.fn(), isReady: () => true }
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: StatusListener, options?: { replay?: boolean }) => {
      hooks.statusListeners.add(listener)
      hooks.replayRequests.push(options?.replay)
      return () => hooks.statusListeners.delete(listener)
    },
    subscribePaneStatusClear: (listener: ClearListener) => {
      hooks.clearListeners.add(listener)
      return () => hooks.clearListeners.delete(listener)
    }
  }
}))
vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  setMigrationUnsupportedPtyListener: vi.fn()
}))
vi.mock('./synthetic-title-runtime', () => ({
  driveSyntheticTitleFromHook: vi.fn(),
  stopAllSyntheticTitleSpinners: vi.fn()
}))

const popoutSent: { channel: string; paneKey: string | undefined }[] = []
let popoutOpen = true

vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () =>
    popoutOpen
      ? {
          webContents: {
            send: (channel: string, event: { paneKey?: string }) =>
              popoutSent.push({ channel, paneKey: event.paneKey })
          }
        }
      : null
}))

import {
  clearMainWindowAgentStatusListeners,
  installMainWindowAgentStatusListeners
} from './main-window-agent-status'
import { mainProcessState } from './main-process-state'

const windowSent: { channel: string; paneKey: string | undefined }[] = []

function fakeWindow(destroyed: () => boolean): typeof mainProcessState.mainWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a BrowserWindow cannot be constructed in the node test env; the handler only calls isDestroyed() and webContents.send(), both provided here.
  return {
    isDestroyed: destroyed,
    webContents: {
      send: (channel: string, event: { paneKey?: string }) =>
        windowSent.push({ channel, paneKey: event.paneKey })
    }
  } as unknown as typeof mainProcessState.mainWindow
}

function statusPayload(paneKey: string): EnrichedAgentHookEventPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a status-row fixture; every field the window handler destructures is present, the rest are optional.
  return {
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'repo::/wt',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    payload: { state: 'working', prompt: 'ship it', agentType: 'codex' }
  } as EnrichedAgentHookEventPayload
}

function emitStatus(paneKey: string): void {
  for (const listener of hooks.statusListeners) {
    listener(statusPayload(paneKey))
  }
}

function emitClear(paneKey: string): void {
  for (const listener of hooks.clearListeners) {
    listener({ paneKey })
  }
}

beforeEach(() => {
  clearMainWindowAgentStatusListeners()
  hooks.statusListeners.clear()
  hooks.clearListeners.clear()
  hooks.replayRequests.length = 0
  windowSent.length = 0
  popoutSent.length = 0
  popoutOpen = true
  mainProcessState.runtime = null
})

describe('the main window as a status subscriber', () => {
  it('keeps delivering to the dashboard pop-out after the main window is destroyed', () => {
    let destroyed = false
    const window = fakeWindow(() => destroyed)
    mainProcessState.mainWindow = window
    installMainWindowAgentStatusListeners({
      window: window!,
      maybeAutoRenameBranchOnFirstWork: vi.fn(),
      onRecordAgentState: vi.fn()
    })

    destroyed = true
    emitStatus('pane-after-destroy')
    emitClear('pane-after-destroy')

    expect(popoutSent).toEqual([
      { channel: 'agentStatus:set', paneKey: 'pane-after-destroy' },
      { channel: 'agentStatus:clear', paneKey: 'pane-after-destroy' }
    ])
    expect(windowSent).toEqual([])
  })

  it('asks for a replay so a freshly created window catches up on cached rows', () => {
    const window = fakeWindow(() => false)
    mainProcessState.mainWindow = window
    installMainWindowAgentStatusListeners({
      window: window!,
      maybeAutoRenameBranchOnFirstWork: vi.fn(),
      onRecordAgentState: vi.fn()
    })

    expect(hooks.replayRequests).toEqual([true])
  })

  it('ends its subscriptions on close instead of nulling a shared slot', () => {
    const window = fakeWindow(() => false)
    mainProcessState.mainWindow = window
    installMainWindowAgentStatusListeners({
      window: window!,
      maybeAutoRenameBranchOnFirstWork: vi.fn(),
      onRecordAgentState: vi.fn()
    })
    expect(hooks.statusListeners.size).toBe(1)
    expect(hooks.clearListeners.size).toBe(1)

    clearMainWindowAgentStatusListeners()

    expect(hooks.statusListeners.size).toBe(0)
    expect(hooks.clearListeners.size).toBe(0)
    emitStatus('pane-after-close')
    emitClear('pane-after-close')
    expect(windowSent).toEqual([])
    expect(popoutSent).toEqual([])
  })

  it('does not double-deliver when install runs twice', () => {
    const window = fakeWindow(() => false)
    mainProcessState.mainWindow = window
    for (let i = 0; i < 2; i += 1) {
      installMainWindowAgentStatusListeners({
        window: window!,
        maybeAutoRenameBranchOnFirstWork: vi.fn(),
        onRecordAgentState: vi.fn()
      })
    }

    emitStatus('pane-once')

    expect(windowSent).toEqual([{ channel: 'agentStatus:set', paneKey: 'pane-once' }])
  })
})
